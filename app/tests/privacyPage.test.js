import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const html = readFileSync(new URL('../public/privacy.html', import.meta.url), 'utf8')
const headers = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8')

describe('privacy.html', () => {
  it('has no scripts, no inline styles and no third-party resources (CSP: script-src/style-src self)', () => {
    expect(html).not.toMatch(/<script/i)
    expect(html).not.toMatch(/<style/i)
    expect(html).not.toMatch(/\sstyle=/i)
    expect(html).not.toMatch(/\son\w+=/i)
    expect(headers).toContain("style-src 'self'")
    for (const m of html.matchAll(/(?:src|href)="(https?:[^"]+)"/g)) expect(m[1]).toBe('https://github.com/gioxx/andata-ritorno')
    expect(html).toContain('href="/privacy.css"')
  })
  it('has Italian first, then English, each naming the processors and the contact', () => {
    const it = html.indexOf('lang="it" aria-labelledby'), en = html.indexOf('lang="en" aria-labelledby')
    expect(it).toBeGreaterThan(0)
    expect(en).toBeGreaterThan(it)
    for (const part of [html.slice(it, en), html.slice(en)]) {
      for (const w of ['Cloudflare', 'Stripe', 'Resend', 'HMAC', 'privacy@gioxx.org', 'AES-GCM']) expect(part).toContain(w)
    }
  })
})
