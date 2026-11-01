// Theme switch: auto (follows the system), light, dark. Loaded in <head> without defer so the
// stored choice applies before the first paint; the button is wired once the page is parsed.
const KEY = 'ar-landing-theme'
const ORDER = ['auto', 'light', 'dark']
const read = () => {
  try { return localStorage.getItem(KEY) || 'auto' } catch { return 'auto' }
}
const apply = (v) => {
  if (v === 'auto') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = v
}
let current = read()
apply(current)

document.addEventListener('DOMContentLoaded', () => {
  const btn = document.querySelector('[data-theme-toggle]')
  if (!btn) return
  const labels = JSON.parse(btn.dataset.labels)
  const show = (v) => {
    btn.dataset.state = v
    btn.setAttribute('aria-label', labels[v])
    btn.title = labels[v]
  }
  show(current)
  btn.addEventListener('click', () => {
    current = ORDER[(ORDER.indexOf(current) + 1) % ORDER.length]
    try { localStorage.setItem(KEY, current) } catch { /* private mode: this page only */ }
    apply(current)
    show(current)
  })
})

// Language: the Italian pages send browsers with no Italian among their languages to the English
// ones, once. Choosing IT or EN by hand is remembered and always wins. Runs before the first paint.
const LANG_KEY = 'ar-landing-lang'
const EN_PAGE = { '/': '/en/', '/guida/': '/en/guide/' }
const chosen = (() => { try { return localStorage.getItem(LANG_KEY) } catch { return null } })()
const target = EN_PAGE[location.pathname]
const speaksItalian = (navigator.languages?.length ? navigator.languages : [navigator.language]).some((l) => /^it\b/i.test(l || ''))
// Crawlers index each language at its own address (hreflang): never move them.
const crawler = navigator.webdriver || /bot|crawl|spider|slurp|preview|lighthouse/i.test(navigator.userAgent)
// ?hl=it marks a hand-picked language when storage is not available.
const picked = new URLSearchParams(location.search).has('hl')
if (target && !chosen && !picked && !speaksItalian && !crawler) location.replace(target + location.search + location.hash)

document.addEventListener('click', (e) => {
  const a = e.target.closest('a[hreflang]')
  if (!a) return
  try {
    localStorage.setItem(LANG_KEY, a.hreflang)
  } catch {
    const url = new URL(a.href)
    url.searchParams.set('hl', a.hreflang)
    a.href = url.href
  }
})
