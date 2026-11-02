// One-time notice about the anonymous statistics (issue #35). Nothing is sent before it has been
// shown and answered: "OK" keeps them on, "Turn off" turns them off; the menu can change it later.
import { t, getLang, onLangChange } from '../i18n.js'
import { statsOn, setStatsOn, noticeSeen, markNoticeSeen } from '../stats.js'

/**
 * @param {{ shouldShow: () => Promise<boolean>|boolean, onAnswered: () => void }} a
 * @returns {() => Promise<void>} call it whenever the conditions may have changed
 */
export function initStatsNotice({ shouldShow, onAnswered }) {
  const el = document.createElement('aside')
  el.className = 'install-strip stats-strip'
  el.setAttribute('role', 'region')
  el.hidden = true
  const draw = () => {
    el.setAttribute('aria-label', t('stats.stripLabel'))
    el.innerHTML = `<p>${t('stats.strip')} <a href="/privacy.html#${getLang() === 'it' ? 'it' : 'en'}-stats" target="_blank" rel="noopener">${t('stats.more')}</a></p>
      <button type="button" class="strip-off">${t('stats.off')}</button>
      <button type="button" class="strip-go">${t('stats.ok')}</button>`
  }
  onLangChange(() => { if (!el.hidden) draw() })
  el.addEventListener('click', (e) => {
    const off = e.target.closest('.strip-off')
    if (!off && !e.target.closest('.strip-go')) return
    if (off) setStatsOn(false)
    markNoticeSeen()
    el.hidden = true
    onAnswered()
  })
  document.body.prepend(el)
  return async () => {
    const show = statsOn() && !noticeSeen() && await shouldShow()
    if (show && el.hidden) { draw(); el.hidden = false }
    if (!show) el.hidden = true
  }
}
