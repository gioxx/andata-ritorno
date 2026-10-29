// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { familyMenuHtml, familyError, devicesText, FAMILY_ERROR_CODES } from '../src/ui/familyMenu.js'
import { qrSvg } from '../src/ui/familyDialogs.js'
import { setLang } from '../src/i18n.js'
import it_ from '../src/i18n/it.js'
import en_ from '../src/i18n/en.js'

beforeEach(() => setLang('it'))
afterAll(() => setLang('it'))

const acts = (html) => [...html.matchAll(/data-menu="([^"]+)"/g)].map((m) => m[1])
const family = { familyId: 'f', deviceId: 'd', token: 'x', keyRaw: 'k', recoverySecret: 's', cursor: 0, lastSyncAt: null, licenceKind: 'family', deviceLimit: 4 }
const NOW = new Date('2026-10-25T12:00:00Z')

describe('familyMenuHtml', () => {
  it('locked: unlock, code, invite, restore, licence; price pill only with payments on', () => {
    const on = familyMenuHtml({ family: null, payments: true })
    expect(acts(on)).toEqual(['unlock', 'code', 'invite-have', 'restore', 'licence'])
    expect(on).toContain('Condivisione famiglia')
    expect(on).toContain('Stesso guardaroba su più telefoni, cifrato')
    expect(on).toContain('4,99 €')
    const off = familyMenuHtml({ family: null, payments: false })
    expect(off).not.toContain('4,99')
    expect(off).not.toContain('badge')
  })

  it('a redeem still waiting for its answer shows the locked rows', () => {
    expect(acts(familyMenuHtml({ family: { ...family, pending: { op: 'redeem', body: {} } }, payments: false }))[0]).toBe('unlock')
  })

  it('active: name, last sync, devices count, slot price only with payments', () => {
    const info = { state: 'idle', lastSyncAt: '2026-10-25T11:55:00Z', family: { name: 'Famiglia Rossi', deviceLimit: 4, devices: [{ id: 'a' }, { id: 'b' }] } }
    const on = familyMenuHtml({ family, info, payments: true, now: NOW })
    expect(acts(on)).toEqual(['sync', 'devices', 'invite', 'slot', 'code', 'kit', 'leave'])
    expect(on).toContain('Famiglia Rossi')
    expect(on).toContain('Ultima sync: 5 min fa')
    expect(on).toContain('2 / 4')
    expect(on).toContain('1,99 €')
    expect(familyMenuHtml({ family, info, payments: false, now: NOW })).not.toContain('1,99')
    expect(acts(familyMenuHtml({ family, info, payments: false, now: NOW }))).toContain('code') // manual seat codes always work
  })

  it('active before the first sync: no name or count yet, never throws', () => {
    const html = familyMenuHtml({ family, info: null, payments: false, now: NOW })
    expect(html).toContain('Ultima sync: mai')
    expect(html).toContain('– / 4')
  })

  it('escapes the family name', () => {
    const info = { state: 'idle', lastSyncAt: null, family: { name: '<img onerror=x>', deviceLimit: 4, devices: [] } }
    expect(familyMenuHtml({ family, info, payments: false })).not.toContain('<img')
  })

  it('removed: explanation and leave only', () => {
    for (const [f, state] of [[{ ...family, removed: true }, 'idle'], [family, 'removed']]) {
      const html = familyMenuHtml({ family: f, info: { state }, payments: true })
      expect(acts(html)).toEqual(['leave'])
      expect(html).toContain('rimosso')
    }
  })

  it('speaks English too', () => {
    setLang('en')
    expect(familyMenuHtml({ family: null, payments: true })).toContain('€4.99')
  })
})

describe('devicesText', () => {
  it('shows n / m', () => {
    expect(devicesText([{}, {}, {}], 4)).toBe('3 / 4')
    expect(devicesText(undefined, 4)).toBe('– / 4')
  })
})

describe('error messages', () => {
  // The contract table's codes; the worker sources are scanned too, so a new code cannot slip by.
  const CONTRACT = ['bad-code', 'code-used', 'code-is-slot', 'code-is-family', 'not-paid', 'bad-session', 'family-full', 'invite-expired',
    'bad-kit', 'link-expired', 'limit-records', 'limit-photo-size', 'limit-photos', 'limit-storage', 'unauthorized', 'rate-limited', 'offline']
  const workerDir = path.resolve(__dirname, '../../worker/src')
  const fromWorker = fs.existsSync(workerDir)
    ? fs.readdirSync(workerDir).filter((f) => f.endsWith('.js')).flatMap((f) => [...fs.readFileSync(path.join(workerDir, f), 'utf8').matchAll(/HttpError\(\d+,\s*'([a-z-]+)'/g)].map((m) => m[1]))
    : []

  it('covers every contract and worker code, in both languages', () => {
    for (const code of new Set([...CONTRACT, ...fromWorker])) {
      expect(FAMILY_ERROR_CODES, code).toContain(code)
      expect(it_[`family.err.${code}`], `it ${code}`).toBeTruthy()
      expect(en_[`family.err.${code}`], `en ${code}`).toBeTruthy()
    }
  })

  it('maps codes, ApiError-like objects and unknowns', () => {
    expect(familyError({ code: 'code-used' })).toBe('Codice già usato.')
    expect(familyError('offline')).toBe('Nessuna connessione. Riprova quando sei online.')
    expect(familyError({ code: 'http-502' })).toBe(it_['family.err.unknown'])
    expect(familyError(new Error('x'))).toBe(it_['family.err.unknown'])
  })
})

describe('qrSvg', () => {
  it('renders an svg for an invite link', () => {
    expect(qrSvg('https://example.org/join#a.b.c')).toMatch(/^<svg /)
  })
})
