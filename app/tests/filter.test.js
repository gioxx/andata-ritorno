import { describe, it, expect } from 'vitest'
import { visibleItems, UNCATEGORISED } from '../src/ui/filter.js'

const items = [{ id: 1, category: 'c1' }, { id: 2, category: 'c2' }, { id: 3 }, { id: 4, category: 'c3' }]

describe('visibleItems', () => {
  it('empty set shows everything', () => expect(visibleItems(items, new Set())).toEqual(items))
  it('is the union of the selected categories', () => {
    expect(visibleItems(items, new Set(['c1', 'c2'])).map((i) => i.id)).toEqual([1, 2])
  })
  it('hides uncategorised items while a filter is active', () => {
    expect(visibleItems(items, new Set(['c3'])).map((i) => i.id)).toEqual([4])
  })
  it('the uncategorised id shows items without a category, also together with others', () => {
    expect(visibleItems(items, new Set([UNCATEGORISED])).map((i) => i.id)).toEqual([3])
    expect(visibleItems(items, new Set([UNCATEGORISED, 'c1'])).map((i) => i.id)).toEqual([1, 3])
  })
})
