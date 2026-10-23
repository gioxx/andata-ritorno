// Per-field last-writer-wins merge. Pure: no I/O. ISO strings compare lexicographically.

/** Merge two versions of one item; ties keep `a` (the local / first-seen side). */
function mergeItem(a, b) {
  const move = b.movedAt > a.movedAt ? b : a // location travels with movedAt
  const edit = b.updatedAt > a.updatedAt ? b : a // everything else with updatedAt
  const out = {
    ...a,
    location: move.location,
    movedAt: move.movedAt,
    label: edit.label,
    tabId: edit.tabId,
    photoId: edit.photoId,
    updatedAt: edit.updatedAt,
  }
  if (edit.category === undefined) delete out.category
  else out.category = edit.category
  return out
}

const FIELDS = ['tabId', 'location', 'label', 'category', 'photoId', 'movedAt', 'updatedAt']
const same = (a, b) => FIELDS.every((f) => a[f] === b[f])

function collapse(list, merge) {
  const map = new Map()
  for (const x of list) map.set(x.id, map.has(x.id) ? merge(map.get(x.id), x) : x)
  return map
}

/**
 * @param {{tabs:import('../types.js').Tab[], items:import('../types.js').Item[]}} local
 * @param {import('../types.js').Incoming} incoming
 * @returns {import('../types.js').ImportPlan}
 */
export function buildPlan(local, incoming) {
  const localItems = new Map(local.items.map((i) => [i.id, i]))
  const localTabs = new Map(local.tabs.map((t) => [t.id, t]))
  const plan = { tabsPut: [], itemsPut: [], photosPut: new Map(), photosDelete: [], added: 0, updated: 0, metaPut: [] }

  const newerTab = (a, b) => (b.updatedAt > a.updatedAt ? b : a)
  for (const t of collapse(incoming.tabs, newerTab).values()) {
    const cur = localTabs.get(t.id)
    if (!cur) plan.tabsPut.push(t)
    else if (t.updatedAt > cur.updatedAt) {
      plan.tabsPut.push({ ...cur, name: t.name, order: t.order, updatedAt: t.updatedAt })
    }
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
      plan.itemsPut.push(inc)
      plan.added++
      continue
    }
    const merged = mergeItem(cur, inc)
    if (same(merged, cur)) continue
    if (merged.photoId !== cur.photoId) {
      needPhoto(merged)
      plan.photosDelete.push(cur.photoId)
    }
    plan.itemsPut.push(merged)
    plan.updated++
  }
  return plan
}
