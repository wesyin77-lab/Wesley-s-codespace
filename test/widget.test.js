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
  const start = { x: 200, y: 500, width: 364, height: 484 }
  const screen = { x: 0, y: 25, width: 1512, height: 932 }

  it('follows the cursor from the bottom-right corner, top-left fixed', () => {
    assert.deepEqual(resizedBounds(start, { x: 40, y: -100 }, 12, screen), { x: 200, y: 500, width: 404, height: 384 })
  })

  it('never gets too small to use', () => {
    const tiny = resizedBounds(start, { x: -1000, y: -1000 }, 12, screen)
    assert.deepEqual([tiny.width, tiny.height], [WIDGET_MIN.width + 24, WIDGET_MIN.height + 24])
  })

  it('stops at the bottom of the screen (the Dock area)', () => {
    const big = resizedBounds(start, { x: 0, y: 2000 }, 12, screen)
    assert.equal(big.y + big.height, 25 + 932 + 12)
  })
})
