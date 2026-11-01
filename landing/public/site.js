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
    scrollTo({ top: 0, behavior: calm ? 'auto' : 'smooth' })
    // The button hides at the top: hand focus to the first link in the header.
    document.querySelector('.brand')?.focus({ preventScroll: true })
  })
}
