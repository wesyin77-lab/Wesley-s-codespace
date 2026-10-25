import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resizedBounds, widgetBounds, WIDGET_MIN } from '../src/main/widget.js'

const size = { width: 364, height: 484 }
// A MacBook screen below a 25px menu bar, plus an external monitor to its right.
const laptop = { x: 0, y: 25, width: 1512, height: 932 }
const monitor = { x: 1512, y: 0, width: 2560, height: 1415 }

describe('where the desktop widget goes', () => {
  it('first launch: top-right of the main screen, like a new Mac widget', () => {
    assert.deepEqual(widgetBounds(undefined, size, [laptop, monitor]), { x: 1512 - 364 - 24, y: 25 + 24, ...size })
  })

  it('stays exactly where you dragged it', () => {
    assert.deepEqual(widgetBounds({ x: 40, y: 300 }, size, [laptop]), { x: 40, y: 300, ...size })
    assert.deepEqual(widgetBounds({ x: 2000, y: 100 }, size, [laptop, monitor]), { x: 2000, y: 100, ...size })
  })

  it('is pulled fully back on screen if it was left hanging off an edge', () => {
    assert.deepEqual(widgetBounds({ x: 1400, y: 800 }, size, [laptop]), { x: 1512 - 364, y: 25 + 932 - 484, ...size })
  })

  it('comes back to the main screen when its monitor is unplugged', () => {
    assert.deepEqual(widgetBounds({ x: 2000, y: 100 }, size, [laptop]), { x: 1512 - 364 - 24, y: 49, ...size })
  })
})

describe('resizing the widget', () => {
  const screen = { x: 0, y: 25, width: 1512, height: 932 }
  // Sitting low on the screen, just above the Dock: no room to grow downward.
  const low = { x: 200, y: 520, width: 364, height: 436 }

  it('the corner follows the cursor; the opposite corner stays put', () => {
    assert.deepEqual(resizedBounds(low, { x: 40, y: -100 }, 'se', 12, screen), { x: 200, y: 520, width: 404, height: 336 })
  })

  it('near the bottom of the screen it can still get taller, by dragging the top edge up', () => {
    const taller = resizedBounds(low, { x: 0, y: -200 }, 'n', 12, screen)
    assert.deepEqual(taller, { x: 200, y: 320, width: 364, height: 636 })
    assert.equal(taller.y + taller.height, low.y + low.height, 'the bottom edge did not move')
  })

  it('the left edge and the top-left corner work too', () => {
    assert.deepEqual(resizedBounds(low, { x: -50, y: 0 }, 'w', 12, screen), { x: 150, y: 520, width: 414, height: 436 })
    assert.deepEqual(resizedBounds(low, { x: -50, y: -50 }, 'nw', 12, screen), { x: 150, y: 470, width: 414, height: 486 })
  })

  it('an edge only changes its own direction', () => {
    const wider = resizedBounds(low, { x: 80, y: 300 }, 'e', 12, screen)
    assert.equal(wider.height, low.height)
  })

  it('never gets too small to use', () => {
    const tiny = resizedBounds(low, { x: -1000, y: -1000 }, 'se', 12, screen)
    assert.deepEqual([tiny.width, tiny.height], [WIDGET_MIN.width + 24, WIDGET_MIN.height + 24])
    const fromTop = resizedBounds(low, { x: 0, y: 1000 }, 'n', 12, screen)
    assert.equal(fromTop.height, WIDGET_MIN.height + 24)
    assert.equal(fromTop.y + fromTop.height, low.y + low.height)
  })

  it('stops at the screen edges (menu bar on top, Dock at the bottom)', () => {
    assert.equal(resizedBounds(low, { x: 0, y: 2000 }, 's', 12, screen).y + resizedBounds(low, { x: 0, y: 2000 }, 's', 12, screen).height, 25 + 932 + 12)
    assert.equal(resizedBounds(low, { x: 0, y: -2000 }, 'n', 12, screen).y, 25 - 12)
  })
})
