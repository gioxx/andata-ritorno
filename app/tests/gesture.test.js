import { describe, it, expect } from 'vitest'
import { clampScale, containSize, clampPan, pinch, swipeIntent, stepIndex } from '../src/ui/gesture.js'

const vp = { w: 400, h: 800 }
const content = containSize(400, 800, 1600, 1200) // landscape photo in a portrait stage

describe('gesture math', () => {
  it('clampScale limits to 1..5', () => {
    expect(clampScale(0.2)).toBe(1)
    expect(clampScale(3)).toBe(3)
    expect(clampScale(9)).toBe(5)
  })

  it('containSize fits the long side', () => {
    expect(content).toEqual({ w: 400, h: 300 })
    expect(containSize(400, 800, 0, 0)).toEqual({ w: 400, h: 800 })
  })

  it('clampPan is zero at 1x and bounded by the overflow when zoomed', () => {
    expect(clampPan(50, 50, 1, vp, content)).toEqual({ x: 0, y: 0 })
    // 2x: content 800x600 in 400x800 -> x overflow 200, y none (600 < 800)
    expect(clampPan(999, 999, 2, vp, content)).toEqual({ x: 200, y: 0 })
    expect(clampPan(-999, 5, 2, vp, content)).toEqual({ x: -200, y: 0 })
  })

  it('pinch clamps scale and keeps the focal point fixed', () => {
    const t = pinch({ s: 1, x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 0 }, 2, vp, content)
    expect(t.s).toBe(2)
    expect(t.x).toBe(-100) // point 100px right of centre stays under the fingers
    expect(pinch({ s: 4, x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, 10, vp, content).s).toBe(5)
    expect(pinch({ s: 2, x: 100, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, 0.1, vp, content)).toEqual({ s: 1, x: 0, y: 0 })
  })

  it('pinch pans with the midpoint', () => {
    const t = pinch({ s: 2, x: 0, y: 0 }, { x: 0, y: 0 }, { x: 50, y: 0 }, 1, vp, content)
    expect(t).toEqual({ s: 2, x: 50, y: 0 })
  })

  it('swipeIntent: only at 1x, dominant axis, thresholds', () => {
    expect(swipeIntent(-80, 10, 1)).toBe('next')
    expect(swipeIntent(80, 10, 1)).toBe('prev')
    expect(swipeIntent(10, 120, 1)).toBe('close')
    expect(swipeIntent(10, -120, 1)).toBe(null) // swipe up does nothing
    expect(swipeIntent(30, 30, 1)).toBe(null)
    expect(swipeIntent(-200, 0, 2)).toBe(null)
  })

  it('stepIndex stays inside the section', () => {
    expect(stepIndex(0, 'prev', 3)).toBe(null)
    expect(stepIndex(0, 'next', 3)).toBe(1)
    expect(stepIndex(2, 'next', 3)).toBe(null)
  })
})
