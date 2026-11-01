// Page polish, all optional: without this script every section is visible and anchors still work.
// - sections fade in as they scroll into view (skipped with reduced motion);
// - a "back to top" button shows once the hero is out of sight.
const calm = matchMedia('(prefers-reduced-motion: reduce)').matches

if (!calm && 'IntersectionObserver' in window) {
  const items = document.querySelectorAll('[data-reveal]')
  const seen = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue
      e.target.classList.add('is-visible')
      seen.unobserve(e.target)
    }
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 })
  for (const el of items) {
    // Already on screen at load: no animation, so nothing flickers.
    if (el.getBoundingClientRect().top < innerHeight) continue
    el.classList.add('reveal')
    seen.observe(el)
  }
}

const toTop = document.querySelector('[data-to-top]')
if (toTop) {
  const toggle = () => toTop.classList.toggle('is-shown', scrollY > innerHeight * 0.8)
  addEventListener('scroll', toggle, { passive: true })
  toggle()
  toTop.addEventListener('click', () => {
    glide(0)
    // The button hides at the top: hand focus to the first link in the header.
    document.querySelector('.brand')?.focus({ preventScroll: true })
  })
}

// FAQ answers slide open and closed instead of jumping (native <details> still works without this).
if (!calm && 'animate' in Element.prototype) {
  for (const d of document.querySelectorAll('.doc details')) {
    const summary = d.querySelector('summary')
    let anim = null
    summary.addEventListener('click', (e) => {
      e.preventDefault()
      anim?.cancel()
      const start = d.offsetHeight
      const opening = !d.open
      if (opening) d.open = true
      const end = opening ? d.offsetHeight : summary.offsetHeight + parseFloat(getComputedStyle(d).paddingTop) + parseFloat(getComputedStyle(d).paddingBottom)
      d.style.overflow = 'hidden'
      anim = d.animate({ height: [`${start}px`, `${end}px`] }, { duration: 260, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' })
      anim.onfinish = () => {
        if (!opening) d.open = false
        d.style.overflow = ''
        anim = null
      }
    })
  }
}

// Smooth jumps to the page's own sections. Done here rather than with CSS scroll-behavior, which
// some browsers turn off on their own (Firefox's smooth-scrolling setting, system motion settings).
const header = document.querySelector('.site-header')
const ease = (t) => 1 - Math.pow(1 - t, 3)
function glide(y) {
  const from = scrollY, dist = y - from, start = performance.now()
  const ms = Math.min(900, 300 + Math.abs(dist) / 4)
  const step = (now) => {
    const t = Math.min(1, (now - start) / ms)
    scrollTo({ top: from + dist * ease(t), behavior: 'instant' })
    if (t < 1) requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href*="#"]')
  if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  const url = new URL(a.href)
  if (url.origin !== location.origin || url.pathname !== location.pathname || !url.hash) return
  const target = document.getElementById(decodeURIComponent(url.hash.slice(1)))
  if (!target) return
  e.preventDefault()
  const y = target.getBoundingClientRect().top + scrollY - (header?.offsetHeight ?? 0) - 16
  glide(Math.max(0, y))
  history.pushState(null, '', url.hash)
  // Keyboard and screen-reader users land on the section too.
  if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1')
  target.focus({ preventScroll: true })
})
