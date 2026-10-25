// "Where it should be, and since when": the item's place and its last move, in words.
import { t, getLang } from '../i18n.js'

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()

/** Italian elides "dal" before a vowel sound (8, 11) and writes the first of the month as 1°. */
function datePhrase(d, now) {
  const lang = getLang()
  const opts = { day: 'numeric', month: 'long', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) }
  let date = new Intl.DateTimeFormat(lang === 'it' ? 'it-IT' : 'en-GB', opts).format(d)
  if (lang === 'it' && d.getDate() === 1) date = date.replace(/^1 /, '1° ')
  return t(lang === 'it' && [8, 11].includes(d.getDate()) ? 'since.dateElided' : 'since.date', { date })
}

/**
 * e.g. "🏫 A scuola da ieri", "🏠 A casa dal 12 ottobre". Uses movedAt (the last move), else
 * createdAt (never moved). Days are calendar days; '' when there is no usable date.
 * @param {{location:'school'|'home', movedAt?:string, createdAt?:string}} it
 */
export function sinceText(it, now = new Date()) {
  const d = new Date(it.movedAt ?? it.createdAt ?? NaN)
  if (Number.isNaN(d.getTime())) return ''
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86400000)
  const when = days <= 0 ? t('since.today')
    : days === 1 ? t('since.yesterday')
    : days < 7 ? t('since.days', { n: days })
    : datePhrase(d, now)
  return t(it.location === 'school' ? 'since.school' : 'since.home', { when })
}
