// Anonymous usage statistics (issue #35), on by default and off with one tap in the menu.
// Only phones that use A/R without a family take part (family use is already counted on the server).
// At most once per ISO week the app sends three coarse values and nothing else:
//   { v: '3.1', items: '6-20', moves: '1-5' }
// No identifier, no exact count, no date: the server only adds one to a counter for that week.
// Nothing is ever sent before the one-time notice has been shown.
const OFF_KEY = 'ar-stats-off'
const NOTICE_KEY = 'ar-stats-notice'
const WEEK_KEY = 'ar-stats-week'
const DAY_MS = 24 * 60 * 60 * 1000

// Only browsers: Node's experimental global localStorage prints a warning when touched.
const storage = () => (typeof window === 'undefined' ? null : window.localStorage)
const read = (k) => { try { return storage()?.getItem(k) ?? null } catch { return null } }
/** @returns {boolean} false when the browser refused the write (blocked storage, quota full) */
const write = (k, v) => {
  try { if (v == null) storage()?.removeItem(k); else storage()?.setItem(k, v); return true } catch { return false }
}

export const statsOn = () => read(OFF_KEY) !== '1'
export function setStatsOn(on) { write(OFF_KEY, on ? null : '1') }
export const noticeSeen = () => read(NOTICE_KEY) === '1'
export function markNoticeSeen() { write(NOTICE_KEY, '1') }

/** ISO 8601 week, as '2026-W45'. Here only to send at most once a week; the server uses its own clock. */
export function isoWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  const day = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - day)
  const year = d.getUTCFullYear()
  return `${year}-W${String(Math.ceil(((d - Date.UTC(year, 0, 1)) / DAY_MS + 1) / 7)).padStart(2, '0')}`
}

/** @param {number} n @returns {'0'|'1-5'|'6-20'|'21+'} */
export const bucket = (n) => (n <= 0 ? '0' : n <= 5 ? '1-5' : n <= 20 ? '6-20' : '21+')

/** Major.minor only ('3.1.0' → '3.1'); null for development builds, which never send anything. */
export const shortVersion = (v) => (/^(\d+\.\d+)\./.exec(`${v}.`)?.[1] ?? null)

/**
 * The whole message. Moves: items moved in the last seven days (not counting the day they were added).
 * @param {{ version: string, items: {createdAt?: string, movedAt?: string}[], now?: Date }} a
 */
export function pingBody({ version, items, now = new Date() }) {
  const since = new Date(now.getTime() - 7 * DAY_MS).toISOString()
  const moved = items.filter((it) => it.movedAt && it.movedAt !== it.createdAt && it.movedAt >= since).length
  return { v: shortVersion(version), items: bucket(items.length), moves: bucket(moved) }
}

// A claim older than this belongs to a tab that closed mid-request: the week is free again.
const CLAIM_MS = 60 * 1000
let inFlight = null
// The week this tab already sent, kept in memory too: a write that fails later cannot cause a resend.
let sentWeek = null
/** Tests only: forget this tab's memory, as a fresh page load would. */
export function resetSession() { sentWeek = null; inFlight = null }

/**
 * Send this week's ping if everything allows it; never throws, never retries in a loop.
 * Overlapping calls (startup timer, tab shown again, menu, another tab) send at most one ping per
 * week: this tab shares its attempt in flight, and the week is claimed in localStorage before the
 * request leaves, so other tabs skip it. A network failure releases the claim for a later try.
 * @param {{ version: string, items: any[], inFamily: boolean, fetchFn?: typeof fetch, now?: Date }} a
 * @returns {Promise<boolean>} true when a ping was sent and accepted
 */
export function maybePing(a) {
  if (!inFlight) inFlight = attempt(a).finally(() => { inFlight = null })
  return inFlight
}

async function attempt({ version, items, inFamily, fetchFn = (...a) => fetch(...a), now = new Date() }) {
  if (inFamily || !statsOn() || !noticeSeen()) return false
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false
  const week = isoWeek(now)
  const seen = read(WEEK_KEY)
  if (seen === week || sentWeek === week) return false
  const [claimWeek, claimAt] = (seen ?? '').split('@')
  if (claimWeek === week && Date.now() - Number(claimAt) < CLAIM_MS) return false // another tab is sending
  const body = pingBody({ version, items, now })
  if (!body.v) return false
  const claim = `${week}@${Date.now()}`
  // No claim that other tabs and later openings can see, no send: better a missing count than a double one.
  if (!write(WEEK_KEY, claim) || read(WEEK_KEY) !== claim) return false
  try {
    const res = await fetchFn('/api/public/ping', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'omit',
      keepalive: true,
    })
    // Accepted, or refused (bad request, rate limit): the week is done, no second try with the same data.
    if (res.ok || (res.status >= 400 && res.status < 500)) { sentWeek = week; write(WEEK_KEY, week) }
    else if (read(WEEK_KEY) === claim) write(WEEK_KEY, seen)
    return res.ok
  } catch {
    if (read(WEEK_KEY) === claim) write(WEEK_KEY, seen) // offline or blocked: next opening tries again
    return false
  }
}
