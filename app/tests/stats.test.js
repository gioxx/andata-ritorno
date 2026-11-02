// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { bucket, shortVersion, isoWeek, pingBody, maybePing, statsOn, setStatsOn, markNoticeSeen, resetSession } from '../src/stats.js'

const now = new Date('2026-11-04T10:00:00Z')
const day = (n) => new Date(now.getTime() - n * 864e5).toISOString()
const okFetch = () => vi.fn(async () => ({ ok: true, status: 204 }))

beforeEach(() => { localStorage.clear(); resetSession() })

describe('anonymous statistics: what is sent', () => {
  it('only coarse buckets', () => {
    expect([0, 1, 5, 6, 20, 21, 500].map(bucket)).toEqual(['0', '1-5', '1-5', '6-20', '6-20', '21+', '21+'])
  })
  it('major.minor only, nothing for development builds', () => {
    expect(shortVersion('3.1.0')).toBe('3.1')
    expect(shortVersion('10.2')).toBe('10.2')
    expect(shortVersion('dev')).toBeNull()
  })
  it('numbers weeks the ISO way, like the server', () => {
    expect(isoWeek(now)).toBe('2026-W45')
    expect(isoWeek(new Date('2027-01-01T10:00:00Z'))).toBe('2026-W53')
  })
  it('exactly three fields; moves count the last seven days, not the day an item was added', () => {
    const items = [
      { createdAt: day(1), movedAt: day(1) }, // just added
      { createdAt: day(30), movedAt: day(2) },
      { createdAt: day(30), movedAt: day(10) },
    ]
    const body = pingBody({ version: '3.1.0', items, now })
    expect(body).toEqual({ v: '3.1', items: '1-5', moves: '1-5' })
    expect(Object.keys(body).sort()).toEqual(['items', 'moves', 'v'])
  })
})

describe('anonymous statistics: when it is sent', () => {
  const items = [{ createdAt: day(30), movedAt: day(2) }]

  it('never before the one-time notice', async () => {
    const fetchFn = okFetch()
    expect(await maybePing({ version: '3.1.0', items, inFamily: false, fetchFn, now })).toBe(false)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('on by default, at most once per week, nothing in the request but the body', async () => {
    expect(statsOn()).toBe(true)
    markNoticeSeen()
    const fetchFn = okFetch()
    expect(await maybePing({ version: '3.1.0', items, inFamily: false, fetchFn, now })).toBe(true)
    expect(await maybePing({ version: '3.1.0', items, inFamily: false, fetchFn, now: new Date('2026-11-08T20:00:00Z') })).toBe(false)
    expect(fetchFn).toHaveBeenCalledTimes(1)
    const [url, init] = fetchFn.mock.calls[0]
    expect(url).toBe('/api/public/ping')
    expect(init.credentials).toBe('omit')
    expect(Object.keys(init.headers)).toEqual(['content-type'])
    expect(JSON.parse(init.body)).toEqual({ v: '3.1', items: '1-5', moves: '1-5' })
    // The next week sends again.
    expect(await maybePing({ version: '3.1.0', items, inFamily: false, fetchFn, now: new Date('2026-11-09T08:00:00Z') })).toBe(true)
  })

  it('nothing when turned off, in a family, or on a development build', async () => {
    markNoticeSeen()
    const fetchFn = okFetch()
    expect(await maybePing({ version: '3.1.0', items, inFamily: true, fetchFn, now })).toBe(false)
    expect(await maybePing({ version: 'dev', items, inFamily: false, fetchFn, now })).toBe(false)
    setStatsOn(false)
    expect(await maybePing({ version: '3.1.0', items, inFamily: false, fetchFn, now })).toBe(false)
    expect(fetchFn).not.toHaveBeenCalled()
    setStatsOn(true)
    expect(statsOn()).toBe(true)
  })

  it('a network failure tries again later; a refusal skips the week', async () => {
    markNoticeSeen()
    const down = vi.fn(async () => { throw new TypeError('offline') })
    expect(await maybePing({ version: '3.1.0', items, inFamily: false, fetchFn: down, now })).toBe(false)
    const refused = vi.fn(async () => ({ ok: false, status: 429 }))
    expect(await maybePing({ version: '3.1.0', items, inFamily: false, fetchFn: refused, now })).toBe(false)
    const fetchFn = okFetch()
    expect(await maybePing({ version: '3.1.0', items, inFamily: false, fetchFn, now })).toBe(false)
    expect(fetchFn).not.toHaveBeenCalled()
  })
})

describe('anonymous statistics: overlapping attempts', () => {
  const items = [{ createdAt: day(30), movedAt: day(2) }]
  it('calls that overlap in this tab share one request', async () => {
    markNoticeSeen()
    let release
    const fetchFn = vi.fn(() => new Promise((r) => { release = r }))
    const a = maybePing({ version: '3.1.0', items, inFamily: false, fetchFn, now })
    const b = maybePing({ version: '3.1.0', items, inFamily: false, fetchFn, now })
    release({ ok: true, status: 204 })
    expect(await a).toBe(true)
    expect(await b).toBe(true)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
  it('another tab sending the same week (fresh claim) is not duplicated; a stale claim is', async () => {
    markNoticeSeen()
    const fetchFn = okFetch()
    localStorage.setItem('ar-stats-week', `2026-W45@${Date.now()}`)
    expect(await maybePing({ version: '3.1.0', items, inFamily: false, fetchFn, now })).toBe(false)
    expect(fetchFn).not.toHaveBeenCalled()
    localStorage.setItem('ar-stats-week', `2026-W45@${Date.now() - 5 * 60 * 1000}`)
    expect(await maybePing({ version: '3.1.0', items, inFamily: false, fetchFn, now })).toBe(true)
    expect(localStorage.getItem('ar-stats-week')).toBe('2026-W45')
  })
  it('a network failure releases the claim', async () => {
    markNoticeSeen()
    localStorage.setItem('ar-stats-week', '2026-W44')
    const down = vi.fn(async () => { throw new TypeError('offline') })
    expect(await maybePing({ version: '3.1.0', items, inFamily: false, fetchFn: down, now })).toBe(false)
    expect(localStorage.getItem('ar-stats-week')).toBe('2026-W44')
  })
})

describe('anonymous statistics: storage that refuses writes', () => {
  const items = [{ createdAt: day(30), movedAt: day(2) }]
  it('sends nothing when the week cannot be claimed', async () => {
    markNoticeSeen()
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError') })
    const fetchFn = okFetch()
    expect(await maybePing({ version: '3.1.0', items, inFamily: false, fetchFn, now })).toBe(false)
    expect(fetchFn).not.toHaveBeenCalled()
    spy.mockRestore()
  })
  it('a week already sent is not sent again even if recording it failed', async () => {
    markNoticeSeen()
    const later = new Date('2026-12-01T10:00:00Z')
    const fetchFn = vi.fn(async () => {
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError') })
      return { ok: true, status: 204 }
    })
    expect(await maybePing({ version: '3.1.0', items, inFamily: false, fetchFn, now: later })).toBe(true)
    vi.restoreAllMocks()
    localStorage.removeItem('ar-stats-week')
    const again = okFetch()
    expect(await maybePing({ version: '3.1.0', items, inFamily: false, fetchFn: again, now: later })).toBe(false)
    expect(again).not.toHaveBeenCalled()
  })
})

describe('one-time notice', () => {
  it('shows once, and its answer sets the choice', async () => {
    const { initStatsNotice } = await import('../src/ui/statsNotice.js')
    const { noticeSeen } = await import('../src/stats.js')
    const answered = vi.fn()
    const check = initStatsNotice({ shouldShow: async () => true, onAnswered: answered })
    await check()
    const strip = document.querySelector('.stats-strip')
    expect(strip.hidden).toBe(false)
    expect(strip.querySelector('a').getAttribute('href')).toMatch(/privacy\.html#(it|en)-stats$/)
    strip.querySelector('.strip-off').click()
    expect(strip.hidden).toBe(true)
    expect(noticeSeen()).toBe(true)
    expect(statsOn()).toBe(false)
    expect(answered).toHaveBeenCalledOnce()
    await check()
    expect(strip.hidden).toBe(true)
    strip.remove()
  })

  it('stays hidden while there is nothing to count', async () => {
    const { initStatsNotice } = await import('../src/ui/statsNotice.js')
    const check = initStatsNotice({ shouldShow: async () => false, onAnswered: () => {} })
    await check()
    expect(document.querySelector('.stats-strip').hidden).toBe(true)
  })
})
