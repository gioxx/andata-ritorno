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
