/**
 * Desktop-widget mode: the panel lives on the desktop like a macOS widget,
 * above the wallpaper and desktop icons but below every app window, in one
 * place on every Space.
 *
 * Electron has no API for that window level (its `type: 'desktop'` sits below
 * Finder's icons and can't be clicked), so on macOS we set it directly on the
 * NSWindow through the Objective-C runtime, using koffi.
 */

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const MARGIN = 24
// NSWindowCollectionBehavior: CanJoinAllSpaces | Stationary | IgnoresCycle.
// Stationary keeps it in place during Mission Control, like the system widgets.
const DESKTOP_BEHAVIOR = (1 << 0) | (1 << 4) | (1 << 6)
// kCGDesktopIconWindowLevelKey from CGWindowLevel.h.
const DESKTOP_ICON_LEVEL_KEY = 18

/**
 * Where the widget goes: its saved spot if that is still on a screen, otherwise
 * the top-right corner of the main screen, the way new Mac widgets appear.
 */
export function widgetBounds(saved, size, workAreas) {
  const [main] = workAreas
  if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    // The screen under the header's top-left corner (the part you grab) owns it.
    const grip = { x: saved.x + 20, y: saved.y + 20 }
    const area = workAreas.find((a) => grip.x >= a.x && grip.x < a.x + a.width && grip.y >= a.y && grip.y < a.y + a.height)
    if (area) {
      return {
        x: Math.round(Math.min(Math.max(saved.x, area.x), area.x + area.width - size.width)),
        y: Math.round(Math.min(Math.max(saved.y, area.y), area.y + area.height - size.height)),
        ...size,
      }
    }
  }
  return { x: main.x + main.width - size.width - MARGIN, y: main.y + MARGIN, ...size }
}

let native

function loadNative() {
  if (native !== undefined) return native
  native = null
  if (process.platform !== 'darwin') return native
  const koffi = require('koffi')
  const objc = koffi.load('/usr/lib/libobjc.A.dylib')
  const cg = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')
  const sel = objc.func('sel_registerName', 'void *', ['str'])
  native = {
    koffi,
    sel: { window: sel('window'), setLevel: sel('setLevel:'), level: sel('level'), setCollectionBehavior: sel('setCollectionBehavior:') },
    sendPtr: objc.func('objc_msgSend', 'void *', ['void *', 'void *']),
    sendLong: objc.func('objc_msgSend', 'void', ['void *', 'void *', 'long']),
    sendULong: objc.func('objc_msgSend', 'void', ['void *', 'void *', 'unsigned long']),
    getLong: objc.func('objc_msgSend', 'long', ['void *', 'void *']),
    levelForKey: cg.func('CGWindowLevelForKey', 'int', ['int']),
  }
  return native
}

/**
 * Put the window on the desktop layer. Returns the level it ended up at, or
 * undefined where that isn't possible (not macOS): there the widget is just a
 * normal window that doesn't stay on top.
 */
export function pinToDesktop(win) {
  const n = loadNative()
  if (!n) return undefined
  // On macOS the native handle is a pointer to the window's NSView.
  const view = n.koffi.decode(win.getNativeWindowHandle(), 'void *')
  const nsWindow = n.sendPtr(view, n.sel.window)
  if (!nsWindow) throw new Error('No NSWindow for the widget view.')
  n.sendLong(nsWindow, n.sel.setLevel, n.levelForKey(DESKTOP_ICON_LEVEL_KEY) + 1)
  n.sendULong(nsWindow, n.sel.setCollectionBehavior, DESKTOP_BEHAVIOR)
  return n.getLong(nsWindow, n.sel.level)
}

// Sizes are for the visible card; the window adds the transparent chrome around it.
export const WIDGET_PRESETS = [
  { id: 'large', label: 'Same as a large Mac widget', width: 344, height: 344 },
  { id: 'wide', label: 'Wide', width: 500, height: 344 },
  { id: 'default', label: 'Default', width: 340, height: 460 },
  { id: 'tall', label: 'Tall', width: 344, height: 600 },
]
export const WIDGET_MIN = { width: 260, height: 280 }
export const WIDGET_MAX = { width: 900, height: 1200 }

/**
 * Window bounds while dragging the resize corner: the top-left stays put, the size
 * follows the cursor, clamped to sensible limits and to the screen.
 */
export function resizedBounds(start, delta, chrome, workArea) {
  const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max))
  return {
    x: start.x,
    y: start.y,
    width: Math.round(clamp(start.width + delta.x, WIDGET_MIN.width + 2 * chrome,
      Math.min(WIDGET_MAX.width + 2 * chrome, workArea.x + workArea.width - start.x + chrome))),
    height: Math.round(clamp(start.height + delta.y, WIDGET_MIN.height + 2 * chrome,
      Math.min(WIDGET_MAX.height + 2 * chrome, workArea.y + workArea.height - start.y + chrome))),
  }
}
