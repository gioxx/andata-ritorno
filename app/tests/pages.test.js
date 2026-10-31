// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderUnlockPage, renderHandoff, landOn } from '../src/ui/pages.js'
import { routeOf } from '../src/routes.js'
import { ApiError } from '../src/sync/api.js'

let root
beforeEach(() => { document.body.innerHTML = '<div id="app"></div>'; root = document.getElementById('app') })

describe('/unlock page', () => {
  it('shows the code with Copia and where to enter it; the Safari line only on iOS Safari', async () => {
    const api = { unlockSession: vi.fn(async () => ({ code: 'AR-ABCD-EFGH-JK12', kind: 'family' })) }
    await renderUnlockPage(root, { api, sessionId: 'cs_test_1', inSafari: false })
    expect(api.unlockSession).toHaveBeenCalledWith('cs_test_1')
    expect(root.querySelector('.unlockCode').textContent).toBe('AR-ABCD-EFGH-JK12')
    expect(root.querySelector('[data-copy]').textContent).toBe('Copia')
    expect(root.textContent).toContain("Apri A/R e inseriscilo in Menu → Famiglia → Ho già un codice. Te l'abbiamo mandato anche per email.")
    expect(root.textContent).not.toContain('questa pagina è in Safari')
    await renderUnlockPage(root, { api, sessionId: 'cs_test_1', inSafari: true })
    expect(root.textContent).toContain('Se hai installato A/R, aprila dalla schermata Home: questa pagina è in Safari.')
  })

  it('links the privacy policy in a new tab', async () => {
    const api = { unlockSession: vi.fn(async () => ({ code: 'AR-ABCD-EFGH-JK12', kind: 'family' })) }
    await renderUnlockPage(root, { api, sessionId: 'cs_test_1', inSafari: false })
    const a = root.querySelector('a[href="/privacy.html"]')
    expect(a.textContent).toBe('Informativa sulla privacy')
    expect(a.rel).toContain('noopener')
  })

  it('not paid: says so and offers a retry that can succeed', async () => {
    const api = { unlockSession: vi.fn().mockRejectedValueOnce(new ApiError(402, 'not-paid')).mockResolvedValueOnce({ code: 'AR-ABCD-EFGH-JK12', kind: 'family' }) }
    await renderUnlockPage(root, { api, sessionId: 'cs_test_1', inSafari: false })
    expect(root.textContent).toContain('Pagamento non ancora completato.')
    root.querySelector('[data-retry]').click()
    await vi.waitFor(() => expect(root.querySelector('.unlockCode')).not.toBeNull())
  })

  it('a missing or unknown session has no retry', async () => {
    const api = { unlockSession: vi.fn(async () => { throw new ApiError(404, 'bad-session') }) }
    await renderUnlockPage(root, { api, sessionId: '', inSafari: false })
    expect(api.unlockSession).not.toHaveBeenCalled()
    expect(root.textContent).toContain('Sessione di pagamento non trovata.')
    expect(root.querySelector('[data-retry]')).toBeNull()
  })
})

describe('iOS Safari hand-off', () => {
  it('copies the full link for the installed app, or continues here', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const link = 'https://ar.example/join#tok.family-1234.key'
    const done = renderHandoff(root, { kind: 'join', link })
    expect(root.querySelector('[data-copy]').textContent).toBe('Copia invito')
    root.querySelector('[data-copy]').click()
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(link))
    root.querySelector('[data-here]').click()
    await done
    expect(root.innerHTML).toBe('')
  })
})

describe('landOn (routed links)', () => {
  it('iOS Safari: the key leaves the address bar before the hand-off shows, the copy keeps the full link', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    history.replaceState(null, '', '/join#tok.family-1234.key')
    const href = location.href
    const route = routeOf(location.pathname, location.hash, location.search)
    const done = landOn(root, route, { inSafari: true })
    expect(root.querySelector('[data-copy]')).not.toBeNull()
    expect(location.pathname + location.hash).toBe('/')
    root.querySelector('[data-copy]').click()
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(href))
    root.querySelector('[data-here]').click()
    await done
  })

  it('elsewhere: the URL is cleaned and nothing is shown; the plain app route is left alone', async () => {
    history.replaceState(null, '', '/licence#tok')
    await landOn(root, routeOf(location.pathname, location.hash, location.search), { inSafari: false })
    expect(location.pathname + location.hash).toBe('/')
    expect(root.innerHTML).toBe('')
    history.replaceState(null, '', '/?x=1')
    await landOn(root, { page: 'app' }, { inSafari: true })
    expect(location.search).toBe('?x=1')
  })
})
