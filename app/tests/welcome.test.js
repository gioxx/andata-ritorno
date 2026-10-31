// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderWelcome } from '../src/ui/welcome.js'
import { setLang } from '../src/i18n.js'

afterEach(() => setLang('it'))

describe('welcome screen', () => {
  const draw = (cb = {}) => {
    const root = document.createElement('div')
    renderWelcome(root, { onCreate() {}, onImport() {}, ...cb })
    return root
  }

  it('offers "Ho già un codice" next to the invite and restore buttons', () => {
    const root = draw()
    const labels = [...root.querySelectorAll('button')].map((b) => b.textContent)
    const at = labels.indexOf('Ho già un codice')
    expect(at).toBeGreaterThan(-1)
    expect(labels).toContain('Ho un invito')
    expect(labels).toContain('Ripristina famiglia')
    expect(Math.abs(at - labels.indexOf('Ho un invito'))).toBe(1)
    setLang('en')
    expect([...draw().querySelectorAll('button')].map((b) => b.textContent)).toContain('I already have a code')
  })

  it('the code button calls onHaveCode', () => {
    const onHaveCode = vi.fn()
    draw({ onHaveCode }).querySelector('#codeBtn').click()
    expect(onHaveCode).toHaveBeenCalledTimes(1)
  })
})
