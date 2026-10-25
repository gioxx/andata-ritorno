// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { t, detectLang, getLang, getLangChoice, setLang, onLangChange } from '../src/i18n.js'
import { backupInfoLine, errorMessage, blockedTitle, failureParts } from '../src/ui/model.js'
import { formatSummary } from '../src/backup/importer.js'
import it_ from '../src/i18n/it.js'
import en_ from '../src/i18n/en.js'

beforeEach(() => { localStorage.clear(); setLang('it') })
afterAll(() => setLang('it'))

describe('detectLang', () => {
  it('maps browser languages', () => {
    expect(detectLang('it-IT')).toBe('it')
    expect(detectLang('en-GB')).toBe('en')
    expect(detectLang('de')).toBe('en')
    expect(detectLang(undefined)).toBe('en')
  })
})

describe('t', () => {
  it('picks plural forms per language', () => {
    expect(t('import.summary.added', { n: 1 })).toBe('Importato 1 capo')
    expect(t('import.summary.added', { n: 3 })).toBe('Importati 3 capi')
    setLang('en')
    expect(t('import.summary.added', { n: 1 })).toBe('Imported 1 item')
    expect(t('import.summary.added', { n: 3 })).toBe('Imported 3 items')
  })

  it('falls back to Italian, then to the key', () => {
    it_['test.onlyIt'] = 'solo italiano'
    try {
      setLang('en')
      expect(t('test.onlyIt')).toBe('solo italiano')
      expect(t('no.such.key')).toBe('no.such.key')
    } finally {
      delete it_['test.onlyIt']
    }
  })

  it('does not re-expand placeholders inside values', () => {
    expect(t('add.pasteFailed', { message: '{n}', n: 5 })).toBe('Incolla non riuscito: {n}')
  })
})

describe('language choice', () => {
  it('stores the choice, sets <html lang> and notifies', () => {
    const fn = vi.fn()
    const off = onLangChange(fn)
    setLang('en')
    expect(localStorage.getItem('ar-lang')).toBe('en')
    expect(getLang()).toBe('en')
    expect(getLangChoice()).toBe('en')
    expect(document.documentElement.lang).toBe('en')
    expect(fn).toHaveBeenCalledWith('en')
    off()
  })

  it('auto removes the key and follows the browser', () => {
    setLang('en')
    setLang('auto')
    expect(localStorage.getItem('ar-lang')).toBeNull()
    expect(getLangChoice()).toBe('auto')
    expect(getLang()).toBe(detectLang(navigator.language))
  })
})

describe('dictionary parity', () => {
  it('has the same keys and plural shapes in both languages', () => {
    expect(Object.keys(en_).sort()).toEqual(Object.keys(it_).sort())
    for (const k of Object.keys(it_)) {
      const a = it_[k], b = en_[k]
      expect(typeof b, k).toBe(typeof a)
      if (typeof a === 'object') expect(Object.keys(b).sort(), k).toEqual(Object.keys(a).sort())
    }
  })

  it('uses the same placeholders in both languages', () => {
    const ph = (v) => (typeof v === 'object' ? Object.values(v) : [v]).flatMap((s) => s.match(/\{\w+\}/g) ?? [])
    for (const k of Object.keys(it_)) expect([...new Set(ph(en_[k]))].sort(), k).toEqual([...new Set(ph(it_[k]))].sort())
  })
})

describe('English copy through the app helpers', () => {
  it('translates model and importer text', () => {
    setLang('en')
    expect(backupInfoLine(1, null)).toBe('1 item · last backup: never')
    expect(blockedTitle(4)).toBe('4 items cannot be imported')
    expect(errorMessage(new Error('last-tab'))).toBe('At least one tab is required')
    expect(formatSummary({ added: 2, updated: 1, failed: 1, perTab: [{ tabName: 'Sofia', school: 1, home: 1 }] }))
      .toBe('Imported 2 items · Sofia 2 (1 at school, 1 at home) · 1 updated · 1 to redo')
  })

  it('translates failure reason codes; legacy text and unknown codes show as-is', () => {
    const f = (reason) => failureParts({ label: 'x', tabName: 'T', location: 'school', reason }).detail
    setLang('en')
    expect(f('unreadable-photo')).toBe('T · at school · Unreadable photo')
    setLang('it')
    expect(f('unreadable-photo')).toBe('T · a scuola · Foto non leggibile')
    expect(f('Foto non leggibile')).toBe('T · a scuola · Foto non leggibile') // legacy stored todo entry
    expect(f('weird')).toBe('T · a scuola · weird')
  })

  it('a plural entry missing the chosen form does not throw', () => {
    it_['test.p'] = { other: 'many' }
    try { expect(t('test.p', { n: 1 })).toBe('many') } finally { delete it_['test.p'] }
  })
})
