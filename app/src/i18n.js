// Tiny dictionary-based i18n. Language choice lives in localStorage['ar-lang'] ('it'|'en'; absent = auto).
import it from './i18n/it.js'
import en from './i18n/en.js'

const KEY = 'ar-lang'
const DICTS = { it, en }
const listeners = new Set()

/** @returns {'it'|'en'} Italian for Italian browsers, English for everything else. */
export function detectLang(navLang) {
  return String(navLang ?? '').toLowerCase().startsWith('it') ? 'it' : 'en'
}

// Only browsers: Node's experimental global localStorage prints a warning when touched.
const storage = () => (typeof window === 'undefined' ? null : window.localStorage)

/** @returns {'auto'|'it'|'en'} */
export function getLangChoice() {
  try {
    const v = storage()?.getItem(KEY)
    if (v === 'it' || v === 'en') return v
  } catch {} // storage can throw (private mode): behave as auto
  return 'auto'
}

const resolve = (choice) => (choice === 'auto' ? detectLang(globalThis.navigator?.language) : choice)

let current = resolve(getLangChoice())
if (typeof document !== 'undefined') document.documentElement.lang = current

/** @returns {'it'|'en'} */
export const getLang = () => current

/** @param {'auto'|'it'|'en'} choice */
export function setLang(choice) {
  try {
    if (choice === 'it' || choice === 'en') storage()?.setItem(KEY, choice)
    else storage()?.removeItem(KEY)
  } catch {} // the choice still applies for this session
  current = resolve(choice)
  if (typeof document !== 'undefined') document.documentElement.lang = current
  for (const fn of [...listeners]) fn(current)
}

/** @returns {() => void} unsubscribe */
export function onLangChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/**
 * Translate `key`. `{name}` placeholders come from `params`; plural entries are
 * `{ one, other }` objects chosen by `params.n`. Fallback: Italian, then the key itself.
 * @param {string} key
 * @param {Record<string, string|number>} [params]
 */
export function t(key, params = {}) {
  let entry = DICTS[current][key]
  if (entry === undefined) entry = DICTS.it[key]
  if (entry === undefined) return key
  if (typeof entry === 'object') entry = entry[params.n === 1 ? 'one' : 'other'] ?? entry.other ?? entry.one
  // Single pass, so a value containing "{x}" is never expanded again.
  return entry.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m))
}
