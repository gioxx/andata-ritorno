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
  const stub = () => {
    const canvas = { width: 0, height: 0, getContext: () => ({ translate() {}, rotate() {}, drawImage() {} }) }
    vi.stubGlobal('createImageBitmap', async () => ({ width: 600, height: 400, close() {} }))
    vi.stubGlobal('document', { createElement: () => canvas })
    return canvas
  }

  it('one turn swaps dimensions and gives a new photo id, no downscale', async () => {
    stub()
    const out = new Blob(['x'], { type: 'image/webp' })
    let seen
    const photo = await rotatePhoto(new Blob(['in']), 1, async (c) => { seen = { w: c.width, h: c.height }; return out })
    expect(seen).toEqual({ w: 400, h: 600 })
    expect(photo).toMatchObject({ width: 400, height: 600, blob: out })
    expect(photo.id).toMatch(/\S/)
  })

  it('two turns keep the dimensions', async () => {
    stub()
    const photo = await rotatePhoto(new Blob(['in']), 2, async () => new Blob(['x']))
    expect([photo.width, photo.height]).toEqual([600, 400])
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
