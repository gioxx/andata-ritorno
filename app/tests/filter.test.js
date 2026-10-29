import { describe, it, expect } from 'vitest'
import { visibleItems, usableFilters, effectiveCategory, UNCATEGORISED } from '../src/ui/filter.js'

const items = [{ id: 1, category: 'c1' }, { id: 2, category: 'c2' }, { id: 3 }, { id: 4, category: 'c3' }]
const known = new Set(['c1', 'c2', 'c3'])

describe('visibleItems', () => {
  it('empty set shows everything', () => expect(visibleItems(items, new Set(), known)).toEqual(items))
  it('is the union of the selected categories', () => {
    expect(visibleItems(items, new Set(['c1', 'c2']), known).map((i) => i.id)).toEqual([1, 2])
  })
  it('hides uncategorised items while a filter is active', () => {
    expect(visibleItems(items, new Set(['c3']), known).map((i) => i.id)).toEqual([4])
  })
  it('the uncategorised id shows items without a category, also together with others', () => {
    expect(visibleItems(items, new Set([UNCATEGORISED]), known).map((i) => i.id)).toEqual([3])
    expect(visibleItems(items, new Set([UNCATEGORISED, 'c1']), known).map((i) => i.id)).toEqual([1, 3])
  })
})

describe('deleted categories', () => {
  // A synced category deletion leaves the stale id on items (no rewrite, see the sync spec).
  const withoutC3 = new Set(['c1', 'c2'])

  it('an item with a deleted category counts as uncategorised', () => {
    expect(effectiveCategory(items[3], withoutC3)).toBeUndefined()
    expect(effectiveCategory(items[0], withoutC3)).toBe('c1')
    expect(effectiveCategory(items[2], withoutC3)).toBeUndefined()
    expect(visibleItems(items, new Set([UNCATEGORISED]), withoutC3).map((i) => i.id)).toEqual([3, 4])
    expect(visibleItems(items, new Set(['c3']), withoutC3)).toEqual([])
    expect([...usableFilters(items, withoutC3)].sort()).toEqual([UNCATEGORISED, 'c1', 'c2'])
  })

  it('only deleted categories on the items: nothing to filter by', () => {
    expect(usableFilters([{ category: 'gone' }, {}], new Set()).size).toBe(0)
  })
})

describe('usableFilters', () => {
  it('offers "Senza categoria" for a tab whose items are all uncategorised, once categories exist', () => {
    expect([...usableFilters([{ id: 1 }, { id: 2 }], known)]).toEqual([UNCATEGORISED])
    expect(usableFilters([{ id: 1 }], new Set()).size).toBe(0) // no categories at all: nothing to filter by
  })
  it('no "Senza categoria" when every item has a category; nothing for an empty tab', () => {
    expect([...usableFilters([{ category: 'c1' }, { category: 'c2' }], known)].sort()).toEqual(['c1', 'c2'])
    expect(usableFilters([], known).size).toBe(0)
  })
})
