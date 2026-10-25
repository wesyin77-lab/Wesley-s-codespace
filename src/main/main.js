/**
 * Orb's main process: one always-on-top window that is either the ball or the
 * panel, plus the background work (file watching, calendar refresh, reminders,
 * the loopback .ics feed).
 *
 * Window options and the drag/dock IPC are adapted from mini-yifan/dsh-orb-cordis
 * (MIT), packages/helper/src/main.ts.
 */

import { app, BrowserWindow, Menu, Notification, clipboard, globalShortcut, ipcMain, net, screen, shell } from 'electron'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import {
  BALL_WINDOW_SIZE, CHROME_INSET, FloatingPlacement, PANEL_WINDOW_SIZE, clampedBallOrigin, initialWindowBounds,
} from './geometry.js'
import { WIDGET_PRESETS, pinToDesktop, resizedBounds, widgetBounds } from './widget.js'
import { claudeCodeCommand, claudeDesktopStatus, connectClaudeDesktop, serverEntry } from './claude-setup.js'
import { loadConfig, saveConfig } from '../core/config.js'
import { Service } from '../core/service.js'
import { normalizeFeedUrl, refreshFeeds } from '../core/feeds.js'
import { localDate, parseLocal } from '../core/dates.js'

const FEED_REFRESH_MS = 15 * 60_000
const REMINDER_TICK_MS = 30_000
const E2E = process.env.ORB_E2E === '1'
// 'widget' (default): fixed on the desktop behind your windows, like a macOS widget.
// 'ball': the floating ball that stays on top of everything.
const MODE = loadConfig().mode === 'ball' ? 'ball' : 'widget'

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

function initialBounds() {
  const config = loadConfig()
  const work = screen.getPrimaryDisplay().workArea
  if (MODE === 'widget') {
    const areas = [work, ...screen.getAllDisplays().map((d) => d.workArea)]
    return widgetBounds(E2E ? undefined : config.widget, widgetWindowSize(config), areas)
  }
  const saved = config.ball
  return saved && !E2E
    ? collapsedAt(clampedBallOrigin(saved, screen.getDisplayNearestPoint(saved).workArea))
    : initialWindowBounds(work)
}

function openWindow() {
  const created = new BrowserWindow({
    title: 'Orb',
    ...initialBounds(),
    frame: false,
    transparent: true,
    alwaysOnTop: MODE === 'ball',
    // A widget behind other apps must react to the first click (tick a box, grab the
    // resize corner) instead of the click only switching to Orb, like system widgets.
    acceptFirstMouse: MODE === 'widget',
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
    ...process.platform === 'darwin' && MODE === 'ball' ? { type: 'panel' } : {},
    webPreferences: {
      preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  })
  created.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  if (MODE === 'ball') {
    // Above full-screen apps too, and on every Space/virtual desktop.
    created.setAlwaysOnTop(true, 'screen-saver')
    if (process.platform === 'darwin') {
      created.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
    }
  } else {
    let saveTimer
    created.on('moved', () => {
      clearTimeout(saveTimer)
      saveTimer = setTimeout(() => {
        const { x, y } = created.getBounds()
        saveConfig({ widget: { x, y } })
      }, 300)
    })
    // After the shortcut brought it forward to type in, it goes back to the desktop.
    created.on('blur', () => {
      if (!raised) return
      raised = false
      created.setAlwaysOnTop(false)
      sendToDesktop(created)
    })
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
  created.once('ready-to-show', () => {
    created.showInactive()
    if (MODE === 'widget') sendToDesktop(created)
  })
  return created
}

let raised = false

/** Saved card size (or the default), as a window size including the transparent chrome. */
function widgetWindowSize(config = loadConfig()) {
  const card = config.widgetSize ?? { width: PANEL_WINDOW_SIZE.width - 2 * CHROME_INSET, height: PANEL_WINDOW_SIZE.height - 2 * CHROME_INSET }
  return { width: card.width + 2 * CHROME_INSET, height: card.height + 2 * CHROME_INSET }
}

function setWidgetCardSize(card) {
  const { x, y } = win.getBounds()
  const area = screen.getDisplayNearestPoint({ x, y }).workArea
  const next = widgetBounds({ x, y }, { width: card.width + 2 * CHROME_INSET, height: card.height + 2 * CHROME_INSET }, [area])
  win.setBounds(next)
  saveConfig({ widgetSize: card, widget: { x: next.x, y: next.y } })
}

function sendToDesktop(target) {
  try {
    const level = pinToDesktop(target)
    if (level !== undefined) console.log(`[orb] widget on the desktop layer (window level ${level})`)
  } catch (error) {
    // Still usable as an ordinary window that doesn't float; just say why.
    console.error(`[orb] could not move the widget to the desktop layer: ${error.message}`)
  }
}

/** Shortcut in widget mode: bring the widget in front of everything until it loses focus. */
function raiseWidget() {
  raised = true
  win.setAlwaysOnTop(true, 'floating')
  win.show()
  win.focus()
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
    ...MODE === 'widget' ? [{
      label: 'Widget size',
      submenu: WIDGET_PRESETS.map((preset) => ({
        label: `${preset.label} (${preset.width}×${preset.height})`,
        click: () => setWidgetCardSize(preset),
      })),
    }] : [],
    {
      label: MODE === 'widget' ? 'Switch to floating ball' : 'Switch to desktop widget',
      click: () => {
        saveConfig({ mode: MODE === 'widget' ? 'ball' : 'widget' })
        app.relaunch()
        app.exit(0)
      },
    },
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
  // Chromium's network stack, not Node's: it follows the Mac's proxy/VPN settings like the browser does.
  feedStatus = await refreshFeeds(config.feeds, service.paths, { fetchImpl: (url, init) => net.fetch(url, init) })
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
handle('orb:expand', (expanded) => placement?.setExpanded(Boolean(expanded)))
handle('orb:focus', () => {
  if (MODE === 'widget') raiseWidget()
  else win.focus()
})
ipcMain.on('orb:drag-press', (event) => { if (fromBall(event)) placement?.press(screen.getCursorScreenPoint()) })
ipcMain.on('orb:drag-begin', (event) => { if (fromBall(event)) placement?.beginDrag() })
ipcMain.on('orb:drag-move', (event, canDock) => { if (fromBall(event)) placement?.dragTo(screen.getCursorScreenPoint(), canDock !== false) })
handle('orb:drag-end', async (canDock) => {
  if (!placement) return { docked: undefined }
  const result = await placement.endDrag(screen.getCursorScreenPoint(), canDock !== false)
  if (!result.docked) rememberBall()
  return result
})
handle('orb:unsnap', () => placement?.unsnap())

// Widget resize corner: like dragging the ball, the page only signals and the
// size comes from the OS cursor, so the window moving under it can't feed back.
let resizeStart
ipcMain.on('orb:resize-begin', (event, edges) => {
  if (!fromBall(event) || MODE !== 'widget' || typeof edges !== 'string' || !/^[nsew]{1,2}$/.test(edges)) return
  resizeStart = { bounds: win.getBounds(), cursor: screen.getCursorScreenPoint(), edges }
})
ipcMain.on('orb:resize-move', (event) => {
  if (!fromBall(event) || !resizeStart) return
  const cursor = screen.getCursorScreenPoint()
  const area = screen.getDisplayNearestPoint(resizeStart.bounds).workArea
  const delta = { x: cursor.x - resizeStart.cursor.x, y: cursor.y - resizeStart.cursor.y }
  win.setBounds(resizedBounds(resizeStart.bounds, delta, resizeStart.edges, CHROME_INSET, area))
})
ipcMain.on('orb:resize-end', (event) => {
  if (!fromBall(event) || !resizeStart) return
  resizeStart = undefined
  const { x, y, width, height } = win.getBounds()
  saveConfig({ widgetSize: { width: width - 2 * CHROME_INSET, height: height - 2 * CHROME_INSET }, widget: { x, y } })
})

// ---- lifecycle ----------------------------------------------------------------

app.on('second-instance', () => send('orb:summon'))
app.on('before-quit', () => {
  quitting = true
  globalShortcut.unregisterAll()
  icsServer?.close()
})
app.on('window-all-closed', () => app.quit())

export const ready = app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock?.hide()
  reloadService()
  await service.store.ensure()
  win = openWindow()
  if (MODE === 'ball') {
    placement = new FloatingPlacement(win, (point) => {
      const display = screen.getDisplayNearestPoint({ x: Math.round(point.x), y: Math.round(point.y) })
      return { bounds: display.bounds, workArea: display.workArea }
    }, () => screen.getAllDisplays().map((display) => display.bounds))
    screen.on('display-removed', () => void placement.clamp(false))
    screen.on('display-metrics-changed', () => void placement.clamp(false))
  } else {
    // A monitor unplugged with the widget on it: bring it back onto a screen.
    screen.on('display-removed', () => {
      const areas = [screen.getPrimaryDisplay().workArea, ...screen.getAllDisplays().map((d) => d.workArea)]
      const { width, height } = win.getBounds()
      win.setBounds(widgetBounds(win.getBounds(), { width, height }, areas))
    })
  }

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

  await win.loadFile(fileURLToPath(new URL('../renderer/index.html', import.meta.url)), { query: { mode: MODE } })
  await pushState()
  void refreshCalendars()
})

