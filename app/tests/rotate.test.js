import { describe, it, expect, vi, afterEach } from 'vitest'
import { normTurns, rotatePhoto } from '../src/rotate.js'
import { viewerAction, idleRotation } from '../src/ui/rotation.js'

afterEach(() => vi.unstubAllGlobals())

describe('normTurns', () => {
  it('wraps to 0..3', () => {
    expect(normTurns(4)).toBe(0)
    expect(normTurns(5)).toBe(1)
    expect(normTurns(-1)).toBe(3)
    expect(normTurns(0)).toBe(0)
  })
})

describe('rotatePhoto', () => {
  const stub = (closed = { n: 0 }) => {
    const calls = []
    const canvas = { width: 0, height: 0, getContext: () => ({
      translate: (...a) => calls.push(['translate', ...a]),
      rotate: (...a) => calls.push(['rotate', ...a]),
      drawImage: (...a) => calls.push(['drawImage', ...a.slice(1)]),
    }) }
    vi.stubGlobal('createImageBitmap', async () => ({ width: 600, height: 400, close() { closed.n++ } }))
    vi.stubGlobal('document', { createElement: () => canvas })
    return { canvas, calls, closed }
  }

  it.each([[1, 400, 600], [2, 600, 400], [3, 400, 600]])('%i turn(s): exact canvas ops, no downscale', async (n, w, h) => {
    const { calls, closed } = stub()
    const out = new Blob(['x'], { type: 'image/webp' })
    let seen
    const photo = await rotatePhoto(new Blob(['in']), n, async (c) => { seen = { w: c.width, h: c.height }; return out })
    expect(seen).toEqual({ w, h })
    expect(calls).toEqual([['translate', w / 2, h / 2], ['rotate', (n * Math.PI) / 2], ['drawImage', -300, -200]])
    expect(photo).toMatchObject({ width: w, height: h, blob: out })
    expect(photo.id).toMatch(/\S/)
    expect(closed.n).toBe(1)
  })

  it('closes the bitmap when encoding throws', async () => {
    const { closed } = stub()
    await expect(rotatePhoto(new Blob(['in']), 1, async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(closed.n).toBe(1)
  })

  it('rejects a net zero rotation', async () => {
    stub()
    await expect(rotatePhoto(new Blob(['in']), 4, async () => new Blob())).rejects.toThrow('no-rotation')
  })
})

describe('viewerAction', () => {
  const pending = { active: true, turns: 1 }

  it('rotate enters pending and resets zoom once', () => {
    const r = viewerAction(idleRotation(), 'rotate')
    expect(r.state).toEqual({ active: true, turns: 1 })
    expect(r.effects).toEqual(['resetZoom', 'turn'])
    expect(viewerAction(r.state, 'rotate').effects).toEqual(['turn'])
  })

  it('close while pending discards and never commits', () => {
    const r = viewerAction(pending, 'close')
    expect(r.effects).toEqual(['discard', 'close'])
    expect(r.state).toEqual(idleRotation())
  })

  it('swipe and zoom are ignored while pending, allowed otherwise', () => {
    expect(viewerAction(pending, 'swipe').effects).toEqual([])
    expect(viewerAction(pending, 'zoom').effects).toEqual([])
    expect(viewerAction(idleRotation(), 'swipe').effects).toEqual(['swipe'])
  })

  it('save commits; net 0 turns commits nothing', () => {
    expect(viewerAction(pending, 'save').effects).toEqual(['commit'])
    expect(viewerAction({ active: true, turns: 0 }, 'save').effects).toEqual(['discard'])
  })

  it('cancel discards but stays open', () => {
    expect(viewerAction(pending, 'cancel').effects).toEqual(['discard'])
  })
})
