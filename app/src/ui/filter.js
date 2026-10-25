// Tag filter: pure helper, OR across the selected categories.

/** Filter id for items without a category (no real category id is empty). */
export const UNCATEGORISED = ''

/**
 * The category an item shows: a synced category deletion leaves the stale id on its items
 * (rewriting them would clobber concurrent edits), so an unknown id means "no category".
 * @param {{category?:string}} item @param {Set<string>} knownIds @returns {string|undefined}
 */
export function effectiveCategory(item, knownIds) {
  return item.category && knownIds.has(item.category) ? item.category : undefined
}

/** @template {{category?:string}} T @param {T[]} items @param {Set<string>} filterIds @param {Set<string>} knownIds @returns {T[]} */
export function visibleItems(items, filterIds, knownIds) {
  if (!filterIds?.size) return items
  return items.filter((i) => filterIds.has(effectiveCategory(i, knownIds) ?? UNCATEGORISED))
}

/**
 * Filter ids that make sense for these items: the categories in use, plus UNCATEGORISED
 * when some items have a category and some don't.
 * @param {{category?:string}[]} items @param {Set<string>} knownIds @returns {Set<string>}
 */
export function usableFilters(items, knownIds) {
  const used = new Set(items.map((i) => effectiveCategory(i, knownIds)).filter(Boolean))
  if (used.size && items.some((i) => !effectiveCategory(i, knownIds))) used.add(UNCATEGORISED)
  return used
}
