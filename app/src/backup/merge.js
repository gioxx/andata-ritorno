// Per-field last-writer-wins merge. Pure: no I/O. ISO strings compare lexicographically.

/**
 * Merge two versions of one item; ties keep `a` (the local / first-seen side).
 * `breakTies` (sync only): on an exact tie the field group with the greater JSON wins instead,
 * so two devices merging each other's version end up with the same item.
 */
export function mergeItem(a, b, { breakTies = false } = {}) {
  const wins = (at, val) => at(b) > at(a) || (breakTies && at(b) === at(a) && JSON.stringify(val(b)) > JSON.stringify(val(a)))
  const move = wins((x) => x.movedAt, (x) => x.location) ? b : a // location travels with movedAt
  const edit = wins((x) => x.updatedAt, (x) => [x.label, x.tabId, x.category ?? null]) ? b : a // everything else with updatedAt
  // The photo has its own clock: a label edit must not drag an older photo along (or lose a newer one).
  // An item from before photoAt existed still has its first photo: a side with a photo clock wins
  // over it whatever its updatedAt says (a later label edit is not a photo change). Only when
  // neither side has one (an old backup against old data) does updatedAt decide.
  const legacy = a.photoAt === undefined && b.photoAt === undefined
  const photo = wins((x) => x.photoAt ?? (legacy ? x.updatedAt : ''), (x) => [x.photoId, x.photoAt ?? null]) ? b : a
  const out = {
    ...a,
    location: move.location,
    movedAt: move.movedAt,
    label: edit.label,
    tabId: edit.tabId,
    photoId: photo.photoId,
    updatedAt: edit.updatedAt,
  }
  if (photo.photoAt === undefined) delete out.photoAt
  else out.photoAt = photo.photoAt
  if (edit.category === undefined) delete out.category
  else out.category = edit.category
  return out
}

const FIELDS = ['tabId', 'location', 'label', 'category', 'photoId', 'photoAt', 'movedAt', 'updatedAt']
const same = (a, b) => FIELDS.every((f) => a[f] === b[f])

/**
 * New records (not on this device) go after every local one, in their file order, so tabs
 * or categories from another device never share an `order` with local ones. Existing records
 * keep the order the merge gave them. An empty device keeps the file's orders as they are.
 */
function placeAfterLocal(puts, local) {
  if (!local.size) return
  let max = Math.max(...[...local.values()].map((r) => r.order), ...puts.filter((r) => local.has(r.id)).map((r) => r.order))
  const fresh = puts.map((r, i) => [r, i]).filter(([r]) => !local.has(r.id)).sort(([a], [b]) => a.order - b.order)
  // Copies: the incoming records stay untouched (buildPlan is pure).
  for (const [r, i] of fresh) puts[i] = { ...r, order: ++max }
}

/**
 * Renumber every tab (or category) 0..n-1 once the merge is planned, so no two share an
 * `order` (a newer record from the file may carry an order already used here). On a tie the
 * record coming from the file goes first: it is the newer placement. Records only renumbered
 * keep their updatedAt (they were not edited). An empty device keeps the file's orders.
 */
function compactOrder(puts, local) {
  if (!local.size) return
  const incoming = new Set(puts.map((r) => r.id))
  const final = new Map(local)
  for (const r of puts) final.set(r.id, r)
  const ordered = [...final.values()].sort((a, b) =>
    a.order - b.order || incoming.has(b.id) - incoming.has(a.id) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  ordered.forEach((r, order) => {
    if (r.order === order) return
    const i = puts.findIndex((p) => p.id === r.id)
    if (i >= 0) puts[i] = { ...puts[i], order }
    else puts.push({ ...r, order })
  })
}

function collapse(list, merge) {
  const map = new Map()
  for (const x of list) map.set(x.id, map.has(x.id) ? merge(map.get(x.id), x) : x)
  return map
}

/**
 * @param {{tabs:import('../types.js').Tab[], items:import('../types.js').Item[], categories?:import('../types.js').Category[]}} local
 * @param {import('../types.js').Incoming} incoming
 * @returns {import('../types.js').ImportPlan}
 */
export function buildPlan(local, incoming) {
  const localItems = new Map(local.items.map((i) => [i.id, i]))
  const localTabs = new Map(local.tabs.map((t) => [t.id, t]))
  const localCats = new Map((local.categories ?? []).map((c) => [c.id, c]))
  const plan = { tabsPut: [], categoriesPut: [], itemsPut: [], photosPut: new Map(), photosDelete: [], added: 0, updated: 0, metaPut: [] }

  const newerTab = (a, b) => (b.updatedAt > a.updatedAt ? b : a)
  for (const t of collapse(incoming.tabs, newerTab).values()) {
    const cur = localTabs.get(t.id)
    if (!cur) plan.tabsPut.push(t)
    else if (t.updatedAt > cur.updatedAt) {
      plan.tabsPut.push({ ...cur, name: t.name, order: t.order, updatedAt: t.updatedAt })
    }
  }

  for (const c of collapse(incoming.categories ?? [], newerTab).values()) {
    const cur = localCats.get(c.id)
    if (!cur) plan.categoriesPut.push(c)
    else if (c.updatedAt > cur.updatedAt) {
      // Keep local createdAt; nameKey follows the winner (a rename removes it).
      const { nameKey: _old, ...rest } = cur
      plan.categoriesPut.push({ ...rest, ...(c.nameKey ? { nameKey: c.nameKey } : {}), name: c.name, order: c.order, updatedAt: c.updatedAt })
    }
  }
  placeAfterLocal(plan.tabsPut, localTabs)
  placeAfterLocal(plan.categoriesPut, localCats)
  compactOrder(plan.tabsPut, localTabs)
  compactOrder(plan.categoriesPut, localCats)
  const knownCats = new Set([...localCats.keys(), ...(incoming.categories ?? []).map((c) => c.id)])
  // A category that exists nowhere (old backup, dangling id) must not survive on an item.
  const strip = (it) => {
    if (it.category === undefined || knownCats.has(it.category)) return it
    const { category: _gone, ...rest } = it
    return rest
  }

  const needPhoto = (item) => {
    const blob = incoming.photos.get(item.photoId)
    if (!blob) throw new Error(`missing-photo:${item.id}`) // importer must validate; never orphan
    plan.photosPut.set(item.photoId, blob)
  }

  for (const inc of collapse(incoming.items, mergeItem).values()) {
    const cur = localItems.get(inc.id)
    if (!cur) {
      needPhoto(inc)
      plan.itemsPut.push(strip(inc))
      plan.added++
      continue
    }
    const merged = mergeItem(cur, inc)
    if (same(merged, cur)) continue
    if (merged.photoId !== cur.photoId) {
      needPhoto(merged)
      plan.photosDelete.push(cur.photoId)
    }
    plan.itemsPut.push(strip(merged))
    plan.updated++
  }
  return plan
}
