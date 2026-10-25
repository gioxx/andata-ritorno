// Tag filter: pure helper, OR across the selected categories.

/** Filter id for items without a category (no real category id is empty). */
export const UNCATEGORISED = ''

/** @template {{category?:string}} T @param {T[]} items @param {Set<string>} filterIds @returns {T[]} */
export function visibleItems(items, filterIds) {
  if (!filterIds?.size) return items
  return items.filter((i) => filterIds.has(i.category || UNCATEGORISED))
}

/**
 * Filter ids that make sense for these items: the categories in use, plus UNCATEGORISED
 * when some items have a category and some don't.
 * @param {{category?:string}[]} items @returns {Set<string>}
 */
export function usableFilters(items) {
  const used = new Set(items.map((i) => i.category).filter(Boolean))
  if (used.size && items.some((i) => !i.category)) used.add(UNCATEGORISED)
  return used
}
