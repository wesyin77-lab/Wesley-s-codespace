/**
 * Orb's main process: one always-on-top window that is either the ball or the
 * panel, plus the background work (file watching, calendar refresh, reminders,
 * the loopback .ics feed).
 *
 * Window options and the drag/dock IPC are adapted from mini-yifan/dsh-orb-cordis
 * (MIT), packages/helper/src/main.ts.
 */

import { app, BrowserWindow, Menu, Notification, clipboard, globalShortcut, ipcMain, screen, shell } from 'electron'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import {
  BALL_WINDOW_SIZE, CHROME_INSET, FloatingPlacement, clampedBallOrigin, initialWindowBounds,
} from './geometry.js'
import { claudeCodeCommand, claudeDesktopStatus, connectClaudeDesktop, serverEntry } from './claude-setup.js'
import { loadConfig, saveConfig } from '../core/config.js'
import { Service } from '../core/service.js'
import { normalizeFeedUrl, refreshFeeds } from '../core/feeds.js'
import { localDate, parseLocal } from '../core/dates.js'

const FEED_REFRESH_MS = 15 * 60_000
const REMINDER_TICK_MS = 30_000
const E2E = process.env.ORB_E2E === '1'

if (!app.requestSingleInstanceLock()) app.quit()

let win
let placement
let service
let feedStatus = []
let stopWatching
let icsServer
let quitting = false

const appRoot = fileURLToPath(new URL('../..', import.meta.url))
const mcpScript = join(appRoot, 'src', 'mcp', 'server.js')
const mcpEntry = () => serverEntry(process.execPath, mcpScript)

function fromBall(event) {
  return win !== undefined && !win.isDestroyed() && event.sender === win.webContents
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

function openWindow() {
  const work = screen.getPrimaryDisplay().workArea
  const saved = loadConfig().ball
  const bounds = saved && !E2E
    ? collapsedAt(clampedBallOrigin(saved, screen.getDisplayNearestPoint(saved).workArea))
    : initialWindowBounds(work)
  const created = new BrowserWindow({
    title: 'Orb',
    ...bounds,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: true,
    show: false,
    backgroundColor: '#00000000',
    roundedCorners: false,
    // The default thick frame is a resize border. On a scaled display its DIP
    // inset does not match the bounds we set, so the ball stops short of the edge.
    ...process.platform === 'win32' ? { thickFrame: false } : {},
    ...process.platform === 'darwin' ? { type: 'panel' } : {},
    webPreferences: {
      preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  })
  created.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  // Above full-screen apps too, and on every Space/virtual desktop.
  created.setAlwaysOnTop(true, 'screen-saver')
  if (process.platform === 'darwin') {
    created.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  }
  created.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  created.webContents.on('will-navigate', (event) => event.preventDefault())
  created.webContents.on('context-menu', (_event, params) => {
    if (params.isEditable || params.selectionText) {
      Menu.buildFromTemplate([{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }]).popup({ window: created })
      return
    }
    showMenu()
  })
  created.on('closed', () => {
    if (!quitting) app.quit()
  })
  created.once('ready-to-show', () => created.showInactive())
  return created
}

function collapsedAt(ball) {
  return { x: ball.x - CHROME_INSET, y: ball.y - CHROME_INSET, width: BALL_WINDOW_SIZE, height: BALL_WINDOW_SIZE }
}

function rememberBall() {
  const bounds = win.getBounds()
  if (bounds.width > BALL_WINDOW_SIZE + 4) return
  saveConfig({ ball: { x: bounds.x + CHROME_INSET, y: bounds.y + CHROME_INSET } })
}

function showMenu() {
  const login = app.getLoginItemSettings()
  Menu.buildFromTemplate([
    { label: 'Open to-do file', click: () => void shell.openPath(service.paths.todo) },
    { label: 'Open Orb folder', click: () => void shell.openPath(service.paths.dir) },
    { label: 'Settings…', click: () => send('orb:show', 'settings') },
    { label: 'Refresh calendars', click: () => void refreshCalendars() },
    { type: 'separator' },
    { label: 'Start Orb at login', type: 'checkbox', checked: login.openAtLogin, click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }) },
    { type: 'separator' },
    { label: 'Quit Orb', role: 'quit' },
  ]).popup({ window: win })
}

// ---- state pushed to the page -------------------------------------------------

async function pushState() {
  try {
    const snap = await service.snapshot()
    send('orb:state', snap)
    void service.exportIcs().catch(() => {})
    scheduleReminders(snap.tasks)
  } catch (error) {
    send('orb:error', error.message)
  }
}

async function refreshCalendars() {
  const config = loadConfig()
  if (config.feeds.length === 0) {
    feedStatus = []
    send('orb:calendar-changed')
    return feedStatus
  }
  feedStatus = await refreshFeeds(config.feeds, service.paths)
  send('orb:calendar-changed')
  return feedStatus
}

function reloadService() {
  stopWatching?.()
  service = new Service({ config: loadConfig() })
  stopWatching = service.store.watch(() => void pushState())
}

// ---- reminders ----------------------------------------------------------------

const reminded = new Set()
let reminderTasks = []

function scheduleReminders(tasks) {
  reminderTasks = tasks
}

function checkReminders() {
  const now = Date.now()
  for (const task of reminderTasks) {
    if (task.done || task.cancelled) continue
    const due = [
      task.plan && { at: parseLocal(task.plan.start), what: `Time to start: ${task.title}`, body: `Planned for ${task.plan.minutes} min` },
      task.due?.length > 10 && { at: parseLocal(task.due), what: `Due now: ${task.title}`, body: task.section },
    ].filter(Boolean)
    for (const item of due) {
      const key = `${task.title}|${item.at.toISOString()}|${item.what}`
      // Fire inside a two-minute window so a sleeping laptop doesn't replay old reminders.
      if (reminded.has(key) || item.at > now || now - item.at > 2 * 60_000) continue
      reminded.add(key)
      if (Notification.isSupported()) new Notification({ title: item.what, body: item.body || 'Orb', silent: false }).show()
    }
  }
}

// ---- loopback calendar feed ----------------------------------------------------

function startIcsServer(port) {
  icsServer?.close()
  icsServer = createServer(async (request, response) => {
    if (request.method !== 'GET' || !request.url.startsWith('/orb.ics')) {
      response.writeHead(404).end()
      return
    }
    try {
      const text = await service.exportIcs()
      response.writeHead(200, { 'content-type': 'text/calendar; charset=utf-8', 'cache-control': 'no-cache' }).end(text)
    } catch {
      response.writeHead(500).end()
    }
  })
  icsServer.on('error', () => { icsServer = undefined })
  icsServer.listen(port, '127.0.0.1')
}

// ---- IPC ----------------------------------------------------------------------

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!fromBall(event)) throw new Error('blocked')
    return fn(...args)
  })
}

const str = (value, max = 2000) => {
  if (typeof value !== 'string' || value.length > max) throw new Error('Invalid input.')
  return value
}

handle('orb:snapshot', () => service.snapshot())
handle('orb:preview', async (input) => {
  const { sections } = await service.snapshot()
  return service.previewQuickAdd(str(input), sections)
})
handle('orb:add', async (input) => {
  await service.quickAdd('panel', str(input))
  await pushState()
})
handle('orb:toggle', async (id, done) => {
  await service.complete('panel', str(id, 64), Boolean(done))
  await pushState()
})
handle('orb:update', async (id, patch) => {
  const clean = {}
  if (patch?.title !== undefined) clean.title = str(patch.title, 300)
  if (patch?.due !== undefined) clean.due = patch.due === null ? null : str(patch.due, 16)
  if (patch?.section !== undefined) clean.section = str(patch.section, 60)
  await service.update('panel', str(id, 64), clean)
  await pushState()
})
handle('orb:remove', async (id) => {
  await service.remove('panel', str(id, 64))
  await pushState()
})
handle('orb:plan', async (id, start, minutes) => {
  await service.plan('panel', str(id, 64), start === null ? null : str(start, 16), Number(minutes) || 30)
  await pushState()
})
handle('orb:calendar', (from, to) => service.calendar(str(from, 10), str(to, 10)))
handle('orb:free-time', (from, minutes) => service.freeTime({ from: str(from, 10), days: 1, minutes: Number(minutes) || 30 }))

handle('orb:settings', async () => {
  const config = loadConfig()
  return {
    dataDir: config.dataDir,
    feeds: config.feeds.map((feed) => ({ ...feed, status: feedStatus.find((s) => s.url === feed.url) })),
    hotkey: config.hotkey,
    icsUrl: `http://127.0.0.1:${config.icsPort}/orb.ics`,
    claude: await claudeDesktopStatus(mcpEntry()),
    claudeCode: claudeCodeCommand(process.execPath, mcpScript),
    openAtLogin: app.getLoginItemSettings().openAtLogin,
    platform: process.platform,
  }
})
handle('orb:add-feed', async (name, url) => {
  const normalized = normalizeFeedUrl(str(url))
  const config = loadConfig()
  if (config.feeds.some((f) => normalizeFeedUrl(f.url) === normalized)) throw new Error('That calendar is already added.')
  saveConfig({ feeds: [...config.feeds, { name: str(name, 60).trim() || 'Calendar', url: normalized }] })
  reloadService()
  const status = await refreshCalendars()
  const mine = status.find((s) => s.url === normalized)
  if (mine && !mine.ok) throw new Error(`Added, but it didn't load: ${mine.error}`)
})
handle('orb:remove-feed', async (url) => {
  const config = loadConfig()
  saveConfig({ feeds: config.feeds.filter((f) => f.url !== str(url)) })
  reloadService()
  await refreshCalendars()
})
handle('orb:refresh-feeds', () => refreshCalendars())
handle('orb:connect-claude', () => connectClaudeDesktop(mcpEntry()))
handle('orb:login', (on) => app.setLoginItemSettings({ openAtLogin: Boolean(on) }))
handle('orb:open-file', () => shell.openPath(service.paths.todo))
handle('orb:open-folder', () => shell.openPath(service.paths.dir))
handle('orb:copy', (text) => clipboard.writeText(str(text, 10_000)))
handle('orb:menu', () => showMenu())

// Click-through while a pinned panel is dimmed, so it never blocks the work under it.
// Mouse moves are still forwarded, which is how the page notices the pointer coming back.
handle('orb:click-through', (on) => {
  if (process.platform === 'linux') return
  win.setIgnoreMouseEvents(Boolean(on), { forward: true })
})

// Geometry, as in dsh-orb-cordis: the page only signals; positions come from the OS cursor.
// Expanding never takes focus: hovering the ball must not steal the keyboard
// from whatever the user is typing in. Only the hotkey (or a click) focuses.
handle('orb:expand', (expanded) => placement.setExpanded(Boolean(expanded)))
handle('orb:focus', () => win.focus())
ipcMain.on('orb:drag-press', (event) => { if (fromBall(event)) placement.press(screen.getCursorScreenPoint()) })
ipcMain.on('orb:drag-begin', (event) => { if (fromBall(event)) placement.beginDrag() })
ipcMain.on('orb:drag-move', (event, canDock) => { if (fromBall(event)) placement.dragTo(screen.getCursorScreenPoint(), canDock !== false) })
handle('orb:drag-end', async (canDock) => {
  const result = await placement.endDrag(screen.getCursorScreenPoint(), canDock !== false)
  if (!result.docked) rememberBall()
  return result
})
handle('orb:unsnap', () => placement.unsnap())

// ---- lifecycle ----------------------------------------------------------------

app.on('second-instance', () => send('orb:summon'))
app.on('before-quit', () => {
  quitting = true
  globalShortcut.unregisterAll()
  icsServer?.close()
})
app.on('window-all-closed', () => app.quit())

void app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock?.hide()
  reloadService()
  await service.store.ensure()
  win = openWindow()
  placement = new FloatingPlacement(win, (point) => {
    const display = screen.getDisplayNearestPoint({ x: Math.round(point.x), y: Math.round(point.y) })
    return { bounds: display.bounds, workArea: display.workArea }
  }, () => screen.getAllDisplays().map((display) => display.bounds))
  screen.on('display-removed', () => void placement.clamp(false))
  screen.on('display-metrics-changed', () => void placement.clamp(false))

  const config = loadConfig()
  if (!E2E) {
    try {
      globalShortcut.register(config.hotkey, () => send('orb:summon'))
    } catch {
      // A taken or invalid shortcut must not stop the app; the ball still works.
    }
    startIcsServer(config.icsPort)
  }
  setInterval(() => void refreshCalendars(), FEED_REFRESH_MS)
  setInterval(checkReminders, REMINDER_TICK_MS)
  // Due statuses change at midnight even when the file doesn't.
  let day = localDate(new Date())
  setInterval(() => {
    const now = localDate(new Date())
    if (now !== day) {
      day = now
      void pushState()
    }
  }, 60_000)

  await win.loadFile(fileURLToPath(new URL('../renderer/index.html', import.meta.url)))
  await pushState()
  void refreshCalendars()
})

