// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { isOldHost, newAddressOf, renderMoved, NEW_ORIGIN } from '../src/ui/moved.js'

describe('isOldHost', () => {
  it('matches only the old app address', () => {
    expect(isOldHost('app.ar.gioxx.org')).toBe(true)
    expect(isOldHost('app.ar.gxware.org')).toBe(false)
    expect(isOldHost('localhost')).toBe(false)
  })
})

describe('newAddressOf', () => {
  it('keeps path, query and fragment (invite and licence links carry them)', () => {
    expect(newAddressOf({ pathname: '/join', search: '', hash: '#abc' })).toBe(`${NEW_ORIGIN}/join#abc`)
    expect(newAddressOf({ pathname: '/unlock', search: '?session_id=x', hash: '' })).toBe(`${NEW_ORIGIN}/unlock?session_id=x`)
  })
})

describe('renderMoved', () => {
  it('shows the backup button and the new address when there is data', async () => {
    const root = document.createElement('div')
    const onExport = vi.fn(async () => true)
    renderMoved(root, { hasData: true, onExport })
    expect(root.querySelector('#movedOpen').getAttribute('href')).toBe(`${NEW_ORIGIN}/`)
    expect(root.textContent).toContain('app.ar.gxware.org')
    root.querySelector('#movedExport').click()
    await vi.waitFor(() => expect(onExport).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(root.querySelector('#movedExport').textContent).toMatch(/salvato|saved/i))
  })
})
