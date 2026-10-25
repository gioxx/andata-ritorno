import { describe, it, expect, afterEach } from 'vitest'
import { sinceText } from '../src/ui/since.js'
import { setLang } from '../src/i18n.js'

const now = new Date(2026, 9, 25, 18, 30) // 25 Oct 2026, local time
const at = (y, m, d, h = 9) => new Date(y, m, d, h).toISOString()
const school = (movedAt) => ({ location: 'school', movedAt, createdAt: at(2026, 0, 1) })
const home = (movedAt) => ({ location: 'home', movedAt, createdAt: at(2026, 0, 1) })

afterEach(() => setLang('it'))

describe('sinceText (Italian)', () => {
  it('uses words for the last week, counted in calendar days', () => {
    expect(sinceText(school(at(2026, 9, 25, 7)), now)).toBe('🏫 A scuola da oggi')
    expect(sinceText(home(at(2026, 9, 24, 23)), now)).toBe('🏠 A casa da ieri')
    expect(sinceText(home(at(2026, 9, 22)), now)).toBe('🏠 A casa da 3 giorni')
    expect(sinceText(home(at(2026, 9, 19)), now)).toBe('🏠 A casa da 6 giorni')
  })
  it('switches to the date after a week, with the year only when it differs', () => {
    expect(sinceText(school(at(2026, 9, 12)), now)).toBe('🏫 A scuola dal 12 ottobre')
    expect(sinceText(school(at(2025, 11, 20)), now)).toBe('🏫 A scuola dal 20 dicembre 2025')
  })
  it('gets the Italian articles right', () => {
    expect(sinceText(school(at(2026, 9, 1)), now)).toBe('🏫 A scuola dal 1° ottobre')
    expect(sinceText(school(at(2026, 8, 8)), now)).toBe("🏫 A scuola dall'8 settembre")
    expect(sinceText(school(at(2026, 8, 11)), now)).toBe("🏫 A scuola dall'11 settembre")
  })
  it('falls back to createdAt, and to nothing without a usable date', () => {
    expect(sinceText({ location: 'home', createdAt: at(2026, 9, 25) }, now)).toBe('🏠 A casa da oggi')
    expect(sinceText({ location: 'home', movedAt: 'nonsense' }, now)).toBe('')
    expect(sinceText({ location: 'home' }, now)).toBe('')
  })
  it('a date in the future (clock changed) reads as today', () => {
    expect(sinceText(school(at(2026, 9, 27)), now)).toBe('🏫 A scuola da oggi')
  })
})

describe('sinceText (English)', () => {
  it('reads naturally', () => {
    setLang('en')
    expect(sinceText(school(at(2026, 9, 25)), now)).toBe('🏫 At school since today')
    expect(sinceText(home(at(2026, 9, 24)), now)).toBe('🏠 At home since yesterday')
    expect(sinceText(home(at(2026, 9, 22)), now)).toBe('🏠 At home for 3 days')
    expect(sinceText(school(at(2026, 9, 12)), now)).toBe('🏫 At school since 12 October')
    expect(sinceText(school(at(2025, 11, 20)), now)).toBe('🏫 At school since 20 December 2025')
  })
})
