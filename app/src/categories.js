// Category helpers: fixed defaults (added only on request) and display names.
import { t } from './i18n.js'

/** Fixed order and ids: two devices that both add the defaults merge into one set. */
export const DEFAULT_CATEGORIES = ['body', 'tops', 'trousers', 'dresses', 'jackets', 'pyjamas', 'underwear', 'socks', 'accessories']
  .map((k) => ({ id: `default-${k}`, nameKey: `category.default.${k}` }))

/** Untouched defaults follow the UI language; renamed/custom ones show as typed. */
export function categoryName(cat) {
  return cat.nameKey ? t(cat.nameKey) : cat.name
}

/** @param {{id:string}[]} categories @returns {Array<{id:string,nameKey:string}>} */
export function missingDefaults(categories) {
  const have = new Set(categories.map((c) => c.id))
  return DEFAULT_CATEGORIES.filter((d) => !have.has(d.id))
}
