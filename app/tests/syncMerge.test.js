import { describe, it, expect } from 'vitest'
import { mergeRemote } from '../src/sync/merge.js'

const T0 = '2026-01-01T00:00:00.000Z'
const T1 = '2026-02-01T00:00:00.000Z'
const T2 = '2026-03-01T00:00:00.000Z'
const T3 = '2026-04-01T00:00:00.000Z'
const NOW = '2026-05-01T00:00:00.000Z'
const opts = { now: NOW, defaultTabName: 'Guardaroba', deviceId: 'me' }

const tab = (id, order = 0, at = T0, name = id) => ({ id, name, order, createdAt: T0, updatedAt: at })
const cat = (id, order = 0, at = T0, name = id) => ({ id, name, order, createdAt: T0, updatedAt: at })
const item = (id, tabId, extra = {}) => ({
  id, tabId, location: 'school', label: id, photoId: 'p-' + id, createdAt: T0, movedAt: T0, updatedAt: T0, ...extra,
})
const local = ({ tabs = [tab('A')], categories = [], items = [], tombstones = [] } = {}) =>
  ({ tabs, categories, items, tombstones: new Map(tombstones.map((t) => [t.id, t])) })

let seq = 0
const val = (kind, value, by = 'other') => ({ rid: value.id, seq: ++seq, kind, value, by })
const dead = (kind, id, deletedAt, by = 'other') => ({ rid: id, seq: ++seq, kind, tombstone: { kind, id, deletedAt }, by })
const keys = (list) => list.map((x) => `${x.kind}:${x.id}`).sort()

/** Apply a plan to the plain local snapshot, as applySyncPlan does to IndexedDB. */
function apply(l, plan) {
  const upd = (list, puts, dels) => {
    const m = new Map(list.map((x) => [x.id, x]))
    for (const id of dels) m.delete(id)
    for (const x of puts) m.set(x.id, x)
    return [...m.values()]
  }
  const tombstones = new Map(l.tombstones)
  for (const id of plan.tombstonesDelete) tombstones.delete(id)
  for (const t of plan.tombstonesPut) tombstones.set(t.id, t)
  return {
    tabs: upd(l.tabs, plan.tabsPut, plan.tabsDelete),
    categories: upd(l.categories, plan.categoriesPut, plan.categoriesDelete),
    items: upd(l.items, plan.itemsPut, plan.itemsDelete),
    tombstones,
  }
}

function expectEmpty(plan) {
  for (const k of ['tabsPut', 'tabsDelete', 'categoriesPut', 'categoriesDelete', 'itemsPut', 'itemsDelete',
    'photosDelete', 'tombstonesPut', 'tombstonesDelete', 'pushBack', 'photosNeeded']) expect(plan[k], k).toEqual([])
  expect(plan.movedOrphans).toBe(0)
  expect(plan.changesBy.size).toBe(0)
}

describe('mergeRemote: remote value vs local record', () => {
  it('a new remote item is put and its photo is needed', () => {
    const plan = mergeRemote(local(), [val('item', item('i1', 'A'))], opts)
    expect(plan.itemsPut).toEqual([item('i1', 'A')])
    expect(plan.photosNeeded).toEqual(['p-i1'])
    expect(plan.pushBack).toEqual([])
  })

  it('items merge per field through mergeItem; a merge that differs from the remote is pushed back', () => {
    const mine = item('i1', 'A', { location: 'home', movedAt: T2 })
    const theirs = item('i1', 'A', { label: 'nuovo', updatedAt: T1 })
    const plan = mergeRemote(local({ items: [mine] }), [val('item', theirs)], opts)
    expect(plan.itemsPut).toEqual([{ ...mine, label: 'nuovo', updatedAt: T1 }])
    expect(keys(plan.pushBack)).toEqual(['item:i1'])
  })

  it('a remote item that fully wins is put and not pushed back', () => {
    const theirs = item('i1', 'A', { label: 'nuovo', updatedAt: T1 })
    const plan = mergeRemote(local({ items: [item('i1', 'A')] }), [val('item', theirs)], opts)
    expect(plan.itemsPut).toEqual([theirs])
    expect(plan.pushBack).toEqual([])
  })

  it('an older remote item changes nothing locally and is pushed back', () => {
    const mine = item('i1', 'A', { label: 'mio', updatedAt: T2 })
    const plan = mergeRemote(local({ items: [mine] }), [val('item', item('i1', 'A', { updatedAt: T1 }))], opts)
    expect(plan.itemsPut).toEqual([])
    expect(keys(plan.pushBack)).toEqual(['item:i1'])
  })

  it('tabs and categories: the newer updatedAt wins, an older remote is pushed back', () => {
    const plan = mergeRemote(local({ tabs: [tab('A', 0, T1, 'mio'), tab('B', 1)], categories: [cat('c1', 0, T2, 'mia')] }), [
      val('tab', tab('A', 0, T0, 'vecchio')),
      val('tab', tab('B', 1, T2, 'nuovo')),
      val('category', cat('c1', 0, T1, 'vecchia')),
    ], opts)
    expect(plan.tabsPut).toEqual([tab('B', 1, T2, 'nuovo')])
    expect(plan.categoriesPut).toEqual([])
    expect(keys(plan.pushBack)).toEqual(['category:c1', 'tab:A'])
  })

  it('a tie with identical content changes nothing', () => {
    expectEmpty(mergeRemote(local({ tabs: [tab('A', 0, T1, 'x')] }), [val('tab', tab('A', 0, T1, 'x'))], opts))
  })

  it('a tie with different content goes to the greater JSON on both devices, whatever the key order', () => {
    const x = tab('A', 0, T1, 'x')
    const y = { updatedAt: T1, name: 'y', order: 0, createdAt: T0, id: 'A' } // same record shape, other key order
    const onX = mergeRemote(local({ tabs: [x] }), [val('tab', y)], opts)
    expect(onX.tabsPut).toEqual([y])
    expect(onX.pushBack).toEqual([])
    const onY = mergeRemote(local({ tabs: [y] }), [val('tab', x)], opts)
    expect(onY.tabsPut).toEqual([])
    expect(keys(onY.pushBack)).toEqual(['tab:A'])
  })

  it('tied item fields converge on two devices; the second round pushes nothing back', () => {
    // Every stamp equal, every field group different: each group goes its own way.
    const onX = item('i1', 'A', { label: 'b', location: 'school', photoId: 'p-a', photoAt: T1 })
    const onY = item('i1', 'A', { label: 'a', location: 'home', photoId: 'p-b', photoAt: T1, category: 'c1' })
    const lx = local({ items: [onX] })
    const ly = local({ items: [onY] })
    const px = mergeRemote(lx, [val('item', onY)], opts)
    const py = mergeRemote(ly, [val('item', onX)], opts)
    const ax = apply(lx, px).items[0]
    const ay = apply(ly, py).items[0]
    expect(ax).toEqual(ay)
    expect(ax).toMatchObject({ label: 'b', location: 'school', photoId: 'p-b' })
    expect(ax.category).toBeUndefined() // goes with label/tabId: ["b","A",null] > ["a","A","c1"]
    // Round 2: each device receives what the other now holds.
    for (const [l, p, theirs] of [[lx, px, ay], [ly, py, ax]]) {
      const again = mergeRemote(apply(l, p), [val('item', theirs)], opts)
      expectEmpty(again)
    }
  })

  it('a replaced photo: the old local blob goes, the new one is needed', () => {
    const theirs = item('i1', 'A', { photoId: 'p-new', photoAt: T1, updatedAt: T1 })
    const plan = mergeRemote(local({ items: [item('i1', 'A')] }), [val('item', theirs)], opts)
    expect(plan.photosDelete).toEqual(['p-i1'])
    expect(plan.photosNeeded).toEqual(['p-new'])
  })
})

describe('mergeRemote: remote tombstone vs local record', () => {
  it('deletes an item older than deletedAt (its newest stamp counts) and its photo', () => {
    const it1 = item('i1', 'A', { movedAt: T1 })
    const plan = mergeRemote(local({ items: [it1] }), [dead('item', 'i1', T2)], opts)
    expect(plan.itemsDelete).toEqual(['i1'])
    expect(plan.photosDelete).toEqual(['p-i1'])
    expect(plan.tombstonesPut).toEqual([{ kind: 'item', id: 'i1', deletedAt: T2 }])
    expect(plan.pushBack).toEqual([])
  })

  it('keeps an item edited after deletedAt (movedAt, photoAt or updatedAt) and pushes it back', () => {
    for (const extra of [{ movedAt: T3 }, { photoAt: T3 }, { updatedAt: T3 }]) {
      const plan = mergeRemote(local({ items: [item('i1', 'A', extra)] }), [dead('item', 'i1', T2)], opts)
      expect(plan.itemsDelete).toEqual([])
      expect(plan.tombstonesPut).toEqual([])
      expect(keys(plan.pushBack)).toEqual(['item:i1'])
    }
  })

  it('an exact tie between deletedAt and the newest stamp: the deletion wins', () => {
    const plan = mergeRemote(local({ items: [item('i1', 'A', { updatedAt: T2 })] }), [dead('item', 'i1', T2)], opts)
    expect(plan.itemsDelete).toEqual(['i1'])
    expect(plan.pushBack).toEqual([])
  })

  it('tabs and categories compare deletedAt with updatedAt', () => {
    const plan = mergeRemote(local({ tabs: [tab('A', 0), tab('B', 1, T3)], categories: [cat('c1'), cat('c2', 1, T3)] }), [
      dead('tab', 'A', T2), dead('tab', 'B', T2), dead('category', 'c1', T2), dead('category', 'c2', T2),
    ], opts)
    expect(plan.tabsDelete).toEqual(['A'])
    expect(plan.categoriesDelete).toEqual(['c1'])
    expect(keys(plan.pushBack)).toEqual(['category:c2', 'tab:B'])
    expect(keys(plan.tombstonesPut)).toEqual(['category:c1', 'tab:A'])
  })

  it('a tombstone for an unknown record is stored, so a later older value cannot resurrect it', () => {
    const plan = mergeRemote(local(), [dead('item', 'ghost', T2)], opts)
    expect(plan.tombstonesPut).toEqual([{ kind: 'item', id: 'ghost', deletedAt: T2 }])
    expect(plan.changesBy.size).toBe(0)
  })

  it('an older remote tombstone does not replace a newer local one', () => {
    const plan = mergeRemote(local({ tombstones: [{ kind: 'item', id: 'x', deletedAt: T3 }] }), [dead('item', 'x', T2)], opts)
    expect(plan.tombstonesPut).toEqual([])
  })
})

describe('mergeRemote: remote value vs local tombstone', () => {
  it('a value newer than deletedAt is put and the tombstone dropped', () => {
    const v = item('i1', 'A', { updatedAt: T3 })
    const plan = mergeRemote(local({ tombstones: [{ kind: 'item', id: 'i1', deletedAt: T2 }] }), [val('item', v)], opts)
    expect(plan.itemsPut).toEqual([v])
    expect(plan.tombstonesDelete).toEqual(['i1'])
    expect(plan.pushBack).toEqual([])
  })

  it('a value not newer than deletedAt stays dead and the tombstone is pushed back', () => {
    const plan = mergeRemote(local({ tombstones: [{ kind: 'item', id: 'i1', deletedAt: T2 }] }), [val('item', item('i1', 'A', { movedAt: T1 }))], opts)
    expect(plan.itemsPut).toEqual([])
    expect(plan.tombstonesDelete).toEqual([])
    expect(keys(plan.pushBack)).toEqual(['item:i1'])
    expect(plan.photosNeeded).toEqual([])
  })

  it('re-creating a deleted default category (fixed id) with a newer updatedAt revives it', () => {
    const c = cat('default-socks', 0, T3)
    const plan = mergeRemote(local({ tombstones: [{ kind: 'category', id: 'default-socks', deletedAt: T2 }] }), [val('category', c)], opts)
    expect(plan.categoriesPut).toEqual([c])
    expect(plan.tombstonesDelete).toEqual(['default-socks'])
  })
})

describe('mergeRemote: convergence of items', () => {
  /** Each device merges the other's item, then receives the other's result: round 2 must be empty. */
  function converge(onX, onY) {
    const lx = local({ items: [onX] })
    const ly = local({ items: [onY] })
    const ax = apply(lx, mergeRemote(lx, [val('item', onY)], opts))
    const ay = apply(ly, mergeRemote(ly, [val('item', onX)], opts))
    expect(ax.items[0]).toEqual(ay.items[0])
    expectEmpty(mergeRemote(ax, [val('item', ay.items[0])], opts))
    expectEmpty(mergeRemote(ay, [val('item', ax.items[0])], opts))
    return ax.items[0]
  }

  it('items differing only in createdAt converge on the earlier one', () => {
    const got = converge(item('i1', 'A', { createdAt: T1, updatedAt: T2 }), item('i1', 'A', { updatedAt: T2 }))
    expect(got.createdAt).toBe(T0)
  })

  it('an unknown extra field (newer app version) converges: it follows the edit clock, then its JSON', () => {
    expect(converge(item('i1', 'A', { extra: { a: 1 } }), item('i1', 'A', { extra: { a: 2 } })).extra).toEqual({ a: 2 })
    // Tie: '{}' > '{"extra":"x"}' in JSON order, so both devices drop it; what matters is that they agree.
    expect('extra' in converge(item('i1', 'A', { extra: 'x' }), item('i1', 'A'))).toBe(false)
    expect(converge(item('i1', 'A', { extra: 'old' }), item('i1', 'A', { extra: 'new', updatedAt: T1 })).extra).toBe('new')
    expect(converge(item('i1', 'A', { extra: 'mine', updatedAt: T1 }), item('i1', 'A', { extra: 'aaa', label: 'z', updatedAt: T1 }))).toMatchObject({ extra: 'mine', label: 'z' })
  })

  it('an equal extra field held in another object does not count as a difference', () => {
    const plan = mergeRemote(local({ items: [item('i1', 'A', { extra: { a: [1] } })] }), [val('item', item('i1', 'A', { extra: { a: [1] } }))], opts)
    expectEmpty(plan)
  })

  it('photo clock tie where only one side has photoAt converges', () => {
    const got = converge(item('i1', 'A', { photoAt: T1, updatedAt: T1 }), item('i1', 'A', { updatedAt: T1 }))
    expect('photoAt' in got).toBe(false) // ["p-i1",null] > ["p-i1","2026-…"]: both devices agree on that
  })
})

describe('mergeRemote: orphan items and tabs', () => {
  it('items on a tombstoned tab move to the first remaining tab by order and are pushed back', () => {
    const l = local({ tabs: [tab('B', 2), tab('A', 1), tab('C', 0)], items: [item('i1', 'B')] })
    const plan = mergeRemote(l, [dead('tab', 'B', T2), dead('tab', 'C', T2)], opts)
    expect(plan.tabsDelete.sort()).toEqual(['B', 'C'])
    expect(plan.itemsPut).toEqual([item('i1', 'A', { updatedAt: NOW })])
    expect(plan.itemsDelete).toEqual([])
    expect(plan.movedOrphans).toBe(1)
    expect(keys(plan.pushBack)).toEqual(['item:i1'])
  })

  it('tabs sharing an order: the smaller id is first, so every device picks the same one', () => {
    const l = local({ tabs: [tab('Z', 0), tab('M', 0), tab('X', 1)], items: [item('i1', 'X')] })
    const plan = mergeRemote(l, [dead('tab', 'X', T2)], opts)
    expect(plan.itemsPut).toEqual([item('i1', 'M', { updatedAt: NOW })])
  })

  it('an incoming item on an unknown tab is moved too', () => {
    const plan = mergeRemote(local(), [val('item', item('i1', 'nowhere'))], opts)
    expect(plan.itemsPut).toEqual([item('i1', 'A', { updatedAt: NOW })])
    expect(plan.movedOrphans).toBe(1)
    expect(keys(plan.pushBack)).toEqual(['item:i1'])
  })

  it('no tabs left: one default tab is created, orphans go into it, both pushed back', () => {
    const plan = mergeRemote(local({ items: [item('i1', 'A')] }), [dead('tab', 'A', T2)], opts)
    expect(plan.tabsPut).toHaveLength(1)
    const t = plan.tabsPut[0]
    expect(t).toMatchObject({ name: 'Guardaroba', order: 0, createdAt: NOW, updatedAt: NOW })
    expect(t.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(plan.itemsPut).toEqual([item('i1', t.id, { updatedAt: NOW })])
    expect(plan.movedOrphans).toBe(1)
    expect(keys(plan.pushBack)).toEqual(['item:i1', `tab:${t.id}`])
  })

  it('a category tombstone never rewrites items', () => {
    const l = local({ categories: [cat('c1')], items: [item('i1', 'A', { category: 'c1' })] })
    const plan = mergeRemote(l, [dead('category', 'c1', T2)], opts)
    expect(plan.categoriesDelete).toEqual(['c1'])
    expect(plan.itemsPut).toEqual([])
    expect(plan.pushBack).toEqual([])
  })
})

describe('mergeRemote: changesBy and idempotence', () => {
  it('counts remote records that changed something, per device, excluding this one', () => {
    const plan = mergeRemote(local({ items: [item('old', 'A')] }), [
      val('item', item('i1', 'A'), 'phone1'),
      val('item', item('i2', 'A'), 'phone1'),
      dead('item', 'old', T2, 'phone2'),
      val('item', item('i3', 'A'), 'me'),
      val('tab', tab('A'), 'phone2'), // identical: nothing applied
    ], opts)
    expect([...plan.changesBy]).toEqual([['phone1', 2], ['phone2', 1]])
  })

  it('later records for the same id win within one batch', () => {
    const plan = mergeRemote(local({ items: [item('i1', 'A', { updatedAt: T1 })] }), [
      val('item', item('i1', 'A', { label: 'a', updatedAt: T0 })), // older: alone it would be pushed back
      val('item', item('i1', 'A', { label: 'b', updatedAt: T2 })),
    ], opts)
    expect(plan.itemsPut).toEqual([item('i1', 'A', { label: 'b', updatedAt: T2 })])
    expect(plan.pushBack).toEqual([])
  })

  it('idempotent: applying the same remote batch twice yields an empty plan the second time', () => {
    const l = local({
      tabs: [tab('A'), tab('B', 1)], categories: [cat('c1')],
      items: [item('i1', 'A'), item('i2', 'B'), item('i3', 'A')],
      tombstones: [{ kind: 'item', id: 'i9', deletedAt: T1 }],
    })
    const batch = [
      val('tab', tab('B', 1, T1, 'rinominato')),
      val('category', cat('c2', 1)),
      val('item', item('i1', 'A', { location: 'home', movedAt: T1, category: 'c2', updatedAt: T1 })),
      val('item', item('i4', 'B')),
      val('item', item('i9', 'A', { updatedAt: T2 })),
      dead('item', 'i3', T2),
      dead('category', 'c1', T2),
      dead('item', 'gone', T2),
    ]
    const first = mergeRemote(l, batch, opts)
    expect(first.changesBy.get('other')).toBe(7)
    expectEmpty(mergeRemote(apply(l, first), batch, opts))
  })
})
