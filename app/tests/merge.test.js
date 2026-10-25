import { describe, it, expect } from 'vitest'
import { buildPlan } from '../src/backup/merge.js'

const d = (n) => `2026-01-${String(n).padStart(2, '0')}T00:00:00.000Z`
const tab = (id, over = {}) => ({ id, name: id, order: 0, createdAt: d(1), updatedAt: d(1), ...over })
const item = (id, over = {}) => ({
  id, tabId: 't1', location: 'home', label: id, photoId: 'p-' + id,
  createdAt: d(1), movedAt: d(1), updatedAt: d(1), ...over,
})
const blob = (s) => new Blob([s])
const incoming = (items, photos, tabs = []) => ({
  tabs, items, photos: new Map(photos ?? items.map((i) => [i.photoId, blob(i.photoId)])), failures: [],
})
const empty = { tabs: [], items: [], categories: [] }
const cat = (id, over = {}) => ({ id, name: id, order: 0, createdAt: d(1), updatedAt: d(1), ...over })
const withCats = (inc, categories) => ({ ...inc, categories })

describe('buildPlan', () => {
  it('new item is added with its photo', () => {
    const it1 = item('a')
    const plan = buildPlan(empty, incoming([it1]))
    expect(plan.added).toBe(1)
    expect(plan.updated).toBe(0)
    expect(plan.itemsPut).toEqual([it1])
    expect([...plan.photosPut.keys()]).toEqual(['p-a'])
    expect(plan.metaPut).toEqual([])
  })

  it('newer move wins location, older edit keeps local label', () => {
    const local = item('a', { movedAt: d(1), updatedAt: d(5), label: 'A', location: 'home' })
    const inc = item('a', { movedAt: d(3), updatedAt: d(2), label: 'B', location: 'school' })
    const plan = buildPlan({ tabs: [], items: [local] }, incoming([inc]))
    expect(plan.added).toBe(0)
    expect(plan.updated).toBe(1)
    expect(plan.itemsPut).toHaveLength(1)
    expect(plan.itemsPut[0]).toMatchObject({ location: 'school', label: 'A', movedAt: d(3), updatedAt: d(5) })
    expect(plan.photosPut.size).toBe(0)
    expect(plan.photosDelete).toEqual([])
  })

  it('same file twice is a no-op', () => {
    // v1 re-import: fresh photoId each time, createdAt = updatedAt = movedAt
    const first = item('a', { photoId: 'p-1' })
    const again = item('a', { photoId: 'p-2' })
    const plan = buildPlan({ tabs: [tab('t1')], items: [first] }, incoming([again], null, [tab('t1')]))
    expect(plan.added).toBe(0)
    expect(plan.updated).toBe(0)
    expect(plan.itemsPut).toEqual([])
    expect(plan.tabsPut).toEqual([])
    expect(plan.photosPut.size).toBe(0)
    expect(plan.photosDelete).toEqual([])
  })

  it('duplicate id inside file counts once', () => {
    const older = item('a', { location: 'home', movedAt: d(2), updatedAt: d(2) })
    const newer = item('a', { location: 'school', movedAt: d(4), updatedAt: d(4), photoId: 'p-new' })
    const plan = buildPlan(empty, incoming([older, newer]))
    expect(plan.added).toBe(1)
    expect(plan.itemsPut).toHaveLength(1)
    expect(plan.itemsPut[0].location).toBe('school')
    expect([...plan.photosPut.keys()]).toEqual(['p-new'])
  })

  it('replaced photo deletes old blob', () => {
    const local = item('a', { photoId: 'p-old', updatedAt: d(2) })
    const inc = item('a', { photoId: 'p-new', updatedAt: d(5) })
    const plan = buildPlan({ tabs: [], items: [local] }, incoming([inc]))
    expect(plan.updated).toBe(1)
    expect(plan.itemsPut[0].photoId).toBe('p-new')
    expect(plan.photosDelete).toEqual(['p-old'])
    expect([...plan.photosPut.keys()]).toEqual(['p-new'])
  })

  it('incoming winning only on location puts no photo', () => {
    const local = item('a', { location: 'home', movedAt: d(1), updatedAt: d(5) })
    const inc = item('a', { location: 'school', movedAt: d(3), updatedAt: d(2), photoId: 'other' })
    const plan = buildPlan({ tabs: [], items: [local] }, incoming([inc]))
    expect(plan.photosPut.size).toBe(0)
    expect(plan.photosDelete).toEqual([])
  })

  it('throws when a needed photo is missing', () => {
    expect(() => buildPlan(empty, incoming([item('a')], []))).toThrow('missing-photo:a')
  })

  it('tab rename newer wins, older loses', () => {
    const local = [tab('t1', { name: 'Old', updatedAt: d(3) }), tab('t2', { name: 'Keep', order: 1, updatedAt: d(5) })]
    const inc = [tab('t1', { name: 'New', order: 2, updatedAt: d(4) }), tab('t2', { name: 'Stale', order: 9, updatedAt: d(2) }), tab('t3')]
    const plan = buildPlan({ tabs: local, items: [] }, incoming([], [], inc))
    const byId = Object.fromEntries(plan.tabsPut.map((t) => [t.id, t]))
    expect(byId.t1).toMatchObject({ name: 'New', updatedAt: d(4) })
    // t2 keeps its name and date; it is only renumbered (t2 1, t1 2, t3 after = 0, 1, 2).
    expect(byId.t2).toMatchObject({ name: 'Keep', order: 0, updatedAt: d(5) })
    expect([byId.t1.order, byId.t3.order]).toEqual([1, 2])
  })

  it('new tabs and categories go after the local max; existing ones keep the merge rule; orders end up 0..n-1', () => {
    const local = {
      tabs: [tab('t1', { order: 0 }), tab('t2', { order: 1, updatedAt: d(2) })],
      items: [],
      categories: [cat('c1', { order: 0 }), cat('c2', { order: 1, updatedAt: d(5) })],
    }
    // n1/n2 collide with t1/t2 (orders 0, 1); t2 wins the merge and moves to 5.
    const inc = withCats(
      incoming([], [], [tab('t2', { order: 5, updatedAt: d(3) }), tab('n2', { order: 1 }), tab('n1', { order: 0 })]),
      [cat('c2', { order: 9, updatedAt: d(1) }), cat('k1', { order: 0 })],
    )
    const plan = buildPlan(local, inc)
    // Then every order is renumbered 0..n-1 (t1 already sits at 0, so it is not written).
    expect(Object.fromEntries(plan.tabsPut.map((t) => [t.id, t.order]))).toEqual({ t2: 1, n1: 2, n2: 3 })
    // c2 loses the merge (older): untouched; the new k1 goes after the local max.
    expect(plan.categoriesPut.map((c) => [c.id, c.order])).toEqual([['k1', 2]])
  })

  it('an incoming order that collides with a local one is resolved: the newer record goes first', () => {
    const local = {
      tabs: [tab('t1', { order: 0 }), tab('t2', { order: 1 }), tab('t3', { order: 2 })],
      items: [],
      categories: [cat('c1', { order: 0 }), cat('c2', { order: 1 })],
    }
    // On the other phone t3 was moved to the top and renamed: it arrives newer, with order 0.
    const inc = withCats(incoming([], [], [tab('t3', { name: 'Materna', order: 0, updatedAt: d(4) })]), [cat('c2', { name: 'Calze', order: 0, updatedAt: d(4) })])
    const plan = buildPlan(local, inc)
    const final = (list, puts) => list.map((r) => puts.find((p) => p.id === r.id) ?? r).sort((a, b) => a.order - b.order).map((r) => [r.id, r.order])
    expect(final(local.tabs, plan.tabsPut)).toEqual([['t3', 0], ['t1', 1], ['t2', 2]])
    expect(final(local.categories, plan.categoriesPut)).toEqual([['c2', 0], ['c1', 1]])
    // A record only renumbered keeps its own updatedAt: it was not edited.
    expect(plan.tabsPut.find((t) => t.id === 't1').updatedAt).toBe(d(1))
  })

  it('into a device without tabs or categories, imported orders are kept as they are', () => {
    const inc = withCats(incoming([], [], [tab('a', { order: 0 }), tab('b', { order: 3 })]), [cat('k', { order: 4 })])
    const plan = buildPlan(empty, inc)
    expect(plan.tabsPut.map((t) => [t.id, t.order])).toEqual([['a', 0], ['b', 3]])
    expect(plan.categoriesPut.map((c) => [c.id, c.order])).toEqual([['k', 4]])
  })

  it('two devices with defaults merge without duplicates', () => {
    const ids = ['default-body', 'default-tops', 'default-socks']
    const local = { tabs: [], items: [], categories: ids.map((id, i) => cat(id, { order: i })) }
    const inc = withCats(incoming([]), ids.map((id, i) => cat(id, { order: i, updatedAt: id === 'default-tops' ? d(5) : d(1), name: id === 'default-tops' ? 'Magliette' : id })))
    const plan = buildPlan(local, inc)
    expect(plan.categoriesPut).toHaveLength(1)
    expect(plan.categoriesPut[0]).toMatchObject({ id: 'default-tops', name: 'Magliette', updatedAt: d(5) })
  })

  it('new incoming categories are put; duplicates inside the file collapse to the newest', () => {
    const inc = withCats(incoming([]), [cat('c1'), cat('c1', { name: 'new', updatedAt: d(3) }), cat('c2')])
    const plan = buildPlan(empty, inc)
    expect(plan.categoriesPut.map((c) => [c.id, c.name]).sort()).toEqual([['c1', 'new'], ['c2', 'c2']])
  })

  it('an item pointing to an unknown category is stored uncategorised', () => {
    const inc = withCats(incoming([item('a', { category: 'ghost' }), item('b', { category: 'c1' })]), [cat('c1')])
    const plan = buildPlan(empty, inc)
    const byId = Object.fromEntries(plan.itemsPut.map((i) => [i.id, i]))
    expect('category' in byId.a).toBe(false)
    expect(byId.b.category).toBe('c1')
  })

  it('a category known only locally keeps incoming items categorised', () => {
    const local = { tabs: [], items: [], categories: [cat('c1')] }
    const plan = buildPlan(local, withCats(incoming([item('a', { category: 'c1' })]), []))
    expect(plan.itemsPut[0].category).toBe('c1')
  })
})
