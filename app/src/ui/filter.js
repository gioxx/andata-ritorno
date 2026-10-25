// Tag filter: pure helper, OR across the selected categories.

/** @template {{category?:string}} T @param {T[]} items @param {Set<string>} filterIds @returns {T[]} */
export function visibleItems(items, filterIds) {
  if (!filterIds?.size) return items
  return items.filter((i) => i.category && filterIds.has(i.category))
}
