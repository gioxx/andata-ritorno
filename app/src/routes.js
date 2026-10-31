// Path-routed entry points: links from an invite, a payment or a licence email all land on the
// same single-page app (the host falls back to index.html), which picks what to show from the URL.

/**
 * @typedef {{page:'app'} | {page:'join', invite:string} | {page:'unlock', sessionId:string}
 *   | {page:'licence', linkToken:string}} Route
 */

/**
 * The fragment (invite, licence token) never reaches a server; the session id is a query param
 * because Stripe appends it there.
 * @param {string} pathname @param {string} [hash] @param {string} [search]
 * @returns {Route}
 */
export function routeOf(pathname, hash = '', search = '') {
  const path = String(pathname ?? '/').replace(/\/+$/, '') || '/'
  const frag = String(hash ?? '').replace(/^#/, '')
  if (path === '/join') return { page: 'join', invite: frag }
  if (path === '/licence') return { page: 'licence', linkToken: frag }
  if (path === '/unlock') return { page: 'unlock', sessionId: new URLSearchParams(search ?? '').get('session_id') ?? '' }
  return { page: 'app' }
}

const LINK_TOKEN = /^[A-Za-z0-9_-]{16,128}$/

/**
 * A licence-recovery link pasted into the app: the full link, its `#…` fragment or the bare token.
 * @returns {string} the link token; throws Error('bad-link')
 */
export function parseLicenceLink(input) {
  let s = String(input ?? '').trim()
  const hash = s.indexOf('#')
  if (hash >= 0) s = s.slice(hash + 1)
  if (!LINK_TOKEN.test(s)) throw new Error('bad-link')
  return s
}
