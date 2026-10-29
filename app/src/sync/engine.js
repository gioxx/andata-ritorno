// Background sync for a device in a family. One run: pull every page → decode → merge once →
// apply → upload photos the outbox needs → push the outbox (tabs, categories, items) → sweep
// orphan photos → refresh the family view. Missing photos then download in a separate background
// queue, so a long first download never holds up the next push. Runs never overlap; nothing here
// runs (or touches the network) for a device outside a family.
import {
  loadAll, readOutbox, clearOutbox, getTombstones, applySyncPlan, getMeta, setMeta, getPhotoIds, getPhotoRecord,
  putSyncedPhoto, setSyncTracking, deleteMeta, dropEmptyTabs,
} from '../db.js'
import { encodeRecord, encodeTombstone, decodeRecord } from './records.js'
import { mergeRemote } from './merge.js'
import { encrypt, decrypt } from './crypto.js'
import { getFamily, updateFamily, familyKey, describeFamily, resumePending, sameMembership, KIT_KIND, KIT_RID, isRecoverySecret } from './family.js'
import { runExclusive, reloadFromDb, subscribe } from '../store.js'
import { t } from '../i18n.js'

/** @typedef {import('./family.js').FamilyMeta} FamilyMeta */
/** @typedef {import('../types.js').SyncPlan} SyncPlan */
/**
 * @typedef {{ state:'idle'|'syncing'|'offline'|'removed'|'error', lastSyncAt:string|null, pending:number,
 *   lastChanges:{count:number, by:string|null}, movedOrphans:number, movedOrphansTab:string|null, errorCode:string|null,
 *   deviceNames:Map<string,string|null>,
 *   family:{name:string|null, deviceLimit:number, devices:{id:string, name:string|null, createdAt:string, lastSeenAt:string, isThis:boolean}[]}|null }} SyncStatus
 */

const BATCH = 200 // records per push (server limit)
const MAX_DATA = 64 * 1024 // encrypted record size the server accepts
const DEBOUNCE_MS = 2000
const PHOTO_PARALLEL = 3
const ORPHAN_MS = 30 * 24 * 60 * 60 * 1000
const RETRY_MS = 60 * 1000 // after a 429: the server's limits are per minute
const ID = /^[A-Za-z0-9_-]{8,64}$/
// Push order: a device pulling between two batches never sees an item before its tab, nor a tab
// deletion before the deletions of its items (it would move them to another tab, reviving them).
const PUT_RANK = { [KIT_KIND]: 0, tab: 0, category: 1, item: 2 }
const DEAD_RANK = { item: 2, category: 3, tab: 4 }

/** The user left or joined while a run was in flight: its remaining work belongs to the old membership. */
class MembershipChanged extends Error {}

/** @returns {SyncStatus} */
const freshStatus = () => ({
  state: 'idle', lastSyncAt: null, pending: 0, lastChanges: { count: 0, by: null }, movedOrphans: 0, movedOrphansTab: null, errorCode: null,
  deviceNames: new Map(), family: null,
})

const photoAad = (familyId, pid) => `${familyId}:photo:${pid}`
const enc = new TextEncoder()
const dec = new TextDecoder()

/** Photo plaintext: uint16 header length, JSON header {t: type, w, h}, then the image bytes. */
async function sealPhoto(key, familyId, photo) {
  const head = enc.encode(JSON.stringify({ t: photo.blob.type, w: photo.width, h: photo.height }))
  const bytes = new Uint8Array(await photo.blob.arrayBuffer())
  const plain = new Uint8Array(2 + head.length + bytes.length)
  new DataView(plain.buffer).setUint16(0, head.length)
  plain.set(head, 2)
  plain.set(bytes, 2 + head.length)
  return encrypt(key, photoAad(familyId, photo.id), plain)
}

/** @returns {Promise<import('../types.js').Photo>} */
async function openPhoto(key, familyId, pid, data) {
  const plain = await decrypt(key, photoAad(familyId, pid), data)
  const n = new DataView(plain.buffer, plain.byteOffset).getUint16(0)
  const head = JSON.parse(dec.decode(plain.subarray(2, 2 + n)))
  const blob = new Blob([plain.subarray(2 + n)], { type: String(head.t ?? '') })
  return { id: pid, blob, width: Number(head.w) || 0, height: Number(head.h) || 0 }
}

/** Run `fn` over `list` with at most `n` in flight; the first rejection rejects the whole. */
async function pool(list, n, fn) {
  let next = 0
  const worker = async () => {
    while (next < list.length) await fn(list[next++])
  }
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, worker))
}

const changesLocal = (p) =>
  [p.tabsPut, p.tabsDelete, p.categoriesPut, p.categoriesDelete, p.itemsPut, p.itemsDelete].some((l) => l.length)
const changesAnything = (p) =>
  changesLocal(p) || [p.photosDelete, p.tombstonesPut, p.tombstonesDelete, p.pushBack].some((l) => l.length)

/** The device that brought the most changes, with the total count. */
function summarise(changesBy) {
  let count = 0
  let by = null
  let top = 0
  for (const [dev, n] of changesBy) {
    count += n
    if (n > top) { top = n; by = dev }
  }
  return { count, by }
}

/**
 * @param {{ db:any, api:ReturnType<typeof import('./api.js').createApi>, onApplied?:() => any,
 *   exclusive?:<T>(fn:() => Promise<T>) => Promise<T>, now?:() => string, defaultTabName?:string|(() => string),
 *   setTimer?:Function, clearTimer?:Function, status?:SyncStatus, listeners?:Set<Function> }} opts
 *   exclusive: runs the read-merge-apply step alone (the app passes the store's mutation queue);
 *   onApplied: called after local data changed (outside `exclusive`).
 */
export function createSyncEngine({
  db, api, onApplied = () => {}, exclusive = (fn) => fn(), now = () => new Date().toISOString(),
  defaultTabName = () => t('sync.defaultTab'), setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (id) => clearTimeout(id),
  status = freshStatus(), listeners = new Set(),
}) {
  let running = null
  let again = false
  let timer = null
  let inFamily = false
  let photoRun = null
  let photoAgain = false
  let retryTimer = null
  let photoRetryTimer = null

  function emit(patch) {
    Object.assign(status, patch)
    for (const fn of [...listeners]) fn(status)
  }
  const outboxSize = async () => (await readOutbox(db)).length

  /**
   * The API client for one run, bound to the token the run started with: if the user leaves and
   * joins another family mid-run, the rest of the run fails (401) instead of sending old-key data
   * with the new token.
   */
  const pinned = (meta) => api.withToken?.(meta.token) ?? api

  /** Pull every page, then decode; a record that cannot be decoded is skipped (and logged). */
  async function pull(api, key, meta) {
    const raw = []
    let cursor = meta.cursor ?? 0
    for (;;) {
      const page = await api.pull(cursor)
      raw.push(...page.records)
      cursor = page.next
      if (!page.more) break
    }
    const remote = []
    for (const r of raw) {
      try {
        remote.push(await decodeRecord(key, meta.familyId, r))
      } catch (e) {
        console.warn('sync: skipped a record that could not be read', r.rid, e?.message)
      }
    }
    // The kit record is not wardrobe data: it never reaches the merge. The newest one wins.
    let secret = null
    const wardrobe = []
    for (const r of remote) {
      if (r.kind !== KIT_KIND) wardrobe.push(r)
      else if (isRecoverySecret(r.value?.recoverySecret)) secret = r.value.recoverySecret
    }
    return { remote: wardrobe, cursor, secret }
  }

  /** Merge everything pulled in one step, alone in the mutation queue, and write it in one tx. */
  async function merge(meta, remote) {
    return exclusive(async () => {
      const [{ tabs, categories, items }, tombstones, photoIds] = await Promise.all([loadAll(db), getTombstones(db), getPhotoIds(db)])
      const name = typeof defaultTabName === 'function' ? defaultTabName() : defaultTabName
      const plan = mergeRemote({ tabs, categories, items, tombstones, photoIds }, remote, { now: now(), defaultTabName: name, deviceId: meta.deviceId })
      if (changesAnything(plan)) await applySyncPlan(db, plan)
      return plan
    })
  }

  /** Upload the photos of these items that the server lacks; a photo refused for its size is skipped. */
  async function uploadPhotos(api, key, meta, items) {
    const wanted = new Set(items.map((it) => it.photoId).filter(Boolean))
    if (!wanted.size) return []
    const { photos } = await api.listPhotos()
    for (const p of photos) wanted.delete(p.pid)
    const refused = []
    for (const pid of wanted) {
      const photo = ID.test(pid) && (await getPhotoRecord(db, pid))
      if (!photo) continue // not on this device (yet): the device that has it uploads it
      try {
        await api.putPhoto(pid, await sealPhoto(key, meta.familyId, photo))
      } catch (e) {
        if (e?.status !== 413) throw e
        console.warn('sync: photo refused', pid, e.code)
        refused.push(e.code)
      }
    }
    return refused
  }

  /** @returns {Promise<string[]>} codes of photos the server refused */
  async function push(api, key, meta) {
    const entries = await readOutbox(db)
    if (!entries.length) return []
    const { tabs, categories, items } = await loadAll(db)
    const local = {
      tab: new Map(tabs.map((x) => [x.id, x])),
      category: new Map(categories.map((x) => [x.id, x])),
      item: new Map(items.map((x) => [x.id, x])),
      [KIT_KIND]: new Map(meta.recoverySecret ? [[KIT_RID, { id: KIT_RID, recoverySecret: meta.recoverySecret }]] : []),
    }
    const tombs = await getTombstones(db)
    const jobs = []
    const drop = []
    for (const e of entries) {
      const value = local[e.kind]?.get(e.id)
      const tomb = tombs.get(e.id)
      if (!ID.test(e.id)) {
        console.warn('sync: id the server cannot store', e.kind, e.id)
        drop.push(e)
      } else if (value) jobs.push({ e, rank: PUT_RANK[e.kind], value })
      else if (e.kind !== KIT_KIND && tomb?.kind === e.kind) jobs.push({ e, rank: DEAD_RANK[e.kind], tomb })
      else drop.push(e) // gone without a trace: nothing to send
    }
    if (drop.length) await clearOutbox(db, drop)
    jobs.sort((a, b) => a.rank - b.rank)

    // Photos before the records that reference them.
    const refused = await uploadPhotos(api, key, meta, jobs.filter((j) => j.value && j.e.kind === 'item').map((j) => j.value))
    for (let i = 0; i < jobs.length; i += BATCH) {
      const records = []
      const done = []
      for (const j of jobs.slice(i, i + BATCH)) {
        const by = meta.deviceId
        const rec = j.value
          ? await encodeRecord(key, meta.familyId, { kind: j.e.kind, value: j.value, by })
          : await encodeTombstone(key, meta.familyId, { ...j.tomb, by })
        done.push(j.e)
        if (rec.data.length > MAX_DATA) console.warn('sync: record too large to send', j.e.kind, j.e.id)
        else records.push(rec)
      }
      if (records.length) await api.push(records)
      await clearOutbox(db, done)
    }
    return refused
  }

  /** Fetch photos referenced here but missing on this device, a few at a time. */
  async function downloadPhotos(api, key, meta, items) {
    const have = await getPhotoIds(db)
    const missing = new Map()
    for (const it of items) if (it.photoId && !have.has(it.photoId) && ID.test(it.photoId)) missing.set(it.photoId, it.id)
    let stored = 0
    await pool([...missing], PHOTO_PARALLEL, async ([pid, itemId]) => {
      let data
      try {
        data = await api.getPhoto(pid)
      } catch (e) {
        if (e?.status === 404) return // not uploaded yet: next sync
        throw e
      }
      try {
        if (await putSyncedPhoto(db, itemId, await openPhoto(key, meta.familyId, pid, data))) stored++
      } catch (e) {
        console.warn('sync: skipped a photo that could not be read', pid, e?.message)
      }
    })
    return stored
  }

  /** Delete server photos no local item has referenced for 30 days (only once fully synced). */
  async function sweepOrphans(api, items) {
    const referenced = new Set(items.map((it) => it.photoId))
    const seen = (await getMeta(db, 'orphanSeen')) ?? {}
    const at = now()
    const next = {}
    const { photos } = await api.listPhotos()
    for (const { pid } of photos) {
      if (referenced.has(pid)) continue
      const first = seen[pid] ?? at
      if (Date.parse(at) - Date.parse(first) >= ORPHAN_MS) await api.deletePhoto(pid)
      else next[pid] = first
    }
    await setMeta(db, 'orphanSeen', next)
  }

  /** One pass of the photo queue; never rejects (offline or removed: the next sync retries). */
  async function downloadOnce() {
    const meta = await getFamily(db)
    if (!meta?.token || meta.removed || meta.pending) return
    try {
      const { items } = await loadAll(db)
      if (await downloadPhotos(pinned(meta), await familyKey(meta), meta, items)) await onApplied()
    } catch (e) {
      if (e?.status === 429) retryLater('photos')
      else if (e?.status !== 0 && e?.status !== 401) console.warn('sync: photo download stopped', e)
    }
  }

  /** Start the photo queue, or (while it runs) schedule one more pass after it. */
  function startDownloads() {
    if (photoRun) {
      photoAgain = true
      return photoRun
    }
    photoRun = (async () => {
      try {
        do {
          photoAgain = false
          await downloadOnce()
        } while (photoAgain)
      } finally {
        photoRun = null
      }
    })()
    return photoRun
  }

  /** A rate limit is transient: try again in a minute (one timer per queue). */
  function retryLater(what) {
    if (what === 'photos') {
      if (photoRetryTimer) return
      photoRetryTimer = setTimer(() => { photoRetryTimer = null; return startDownloads() }, RETRY_MS)
    } else {
      if (retryTimer) return
      retryTimer = setTimer(() => { retryTimer = null; return engine.syncNow('retry') }, RETRY_MS)
    }
  }

  /** A joined phone's empty tabs go once the first pull is in (they were never uploaded, no tombstone). */
  async function discardEmptyTabs() {
    const ids = await getMeta(db, 'emptyTabsToDrop')
    if (!ids) return 0
    const dropped = await exclusive(() => dropEmptyTabs(db, ids))
    await deleteMeta(db, 'emptyTabsToDrop')
    return dropped
  }

  async function syncFamily(meta) {
    const api = pinned(meta)
    const key = await familyKey(meta)
    const { remote, cursor, secret } = await pull(api, key, meta)
    /** @type {SyncPlan|null} */
    const plan = remote.length ? await merge(meta, remote) : null
    const kit = secret && secret !== meta.recoverySecret ? { recoverySecret: secret } : {}
    meta = await updateFamily(db, meta, { cursor, ...kit })
    if (!meta) throw new MembershipChanged()
    const droppedTabs = await discardEmptyTabs()
    if ((plan && changesLocal(plan)) || droppedTabs) await onApplied()

    const refused = await push(api, key, meta)
    const { items } = await loadAll(db)
    const pending = await outboxSize()
    if (!pending) await sweepOrphans(api, items)

    const view = await describeFamily(key, await api.family())
    const lastSyncAt = now()
    if (!(await updateFamily(db, meta, { lastSyncAt, deviceLimit: view.deviceLimit }))) throw new MembershipChanged()
    emit({
      state: refused.length ? 'error' : 'idle', errorCode: refused[0] ?? null, lastSyncAt, pending,
      lastChanges: plan ? summarise(plan.changesBy) : { count: 0, by: null },
      movedOrphans: plan?.movedOrphans ?? 0, movedOrphansTab: plan?.movedOrphansTab ?? null,
      family: view, deviceNames: new Map(view.devices.map((d) => [d.id, d.name])),
    })
    startDownloads()
  }

  async function runOnce() {
    let meta = await getFamily(db)
    inFamily = !!meta
    if (!meta) {
      if (status.family || status.state !== 'idle') emit(freshStatus())
      return
    }
    if (meta.removed) {
      setSyncTracking(false)
      emit({ state: 'removed' })
      return
    }
    emit({ state: 'syncing' })
    try {
      if (meta.pending) meta = await resumePending(db, api)
      await syncFamily(meta)
    } catch (e) {
      const membershipError = e instanceof MembershipChanged || e?.status === 401
      const cur = membershipError ? await getFamily(db) : null
      const stillOurs = sameMembership(cur, meta) && cur.token === meta.token
      if (membershipError && !stillOurs) {
        // The user left or joined during this run: what failed belongs to the old membership.
        again = true
        emit({ state: 'idle' })
      } else if (e?.status === 401) {
        // No longer in the family: keep everything local, stop syncing until the user acts.
        setSyncTracking(false)
        await updateFamily(db, meta, { removed: true })
        emit({ state: 'removed', errorCode: null })
      } else if (e?.status === 0) {
        emit({ state: 'offline', pending: await outboxSize() })
      } else if (e?.status === 429) {
        // Not a failure of the data: shown, and retried by itself.
        emit({ state: 'error', errorCode: 'rate-limited', pending: await outboxSize() })
        retryLater('sync')
      } else {
        console.warn('sync failed', e)
        emit({ state: 'error', errorCode: e?.code ?? e?.message ?? 'internal', pending: await outboxSize() })
      }
    }
  }

  const engine = {
    status,
    /** @param {(s:SyncStatus) => void} fn @returns {() => void} unsubscribe */
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    /** Read the stored family (no network): tracking on, or the removed state shown. */
    async init() {
      const meta = await getFamily(db)
      inFamily = !!meta
      if (!meta || meta.pending) return
      if (meta.removed) {
        setSyncTracking(false)
        emit({ state: 'removed' })
        return
      }
      setSyncTracking(true)
      emit({ lastSyncAt: meta.lastSyncAt ?? null, pending: await outboxSize() })
    },
    /**
     * Start a run, or (while one runs) schedule exactly one more after it. Never rejects.
     * @param {'start'|'visible'|'online'|'pull'|'menu'|'line'|'debounce'|'retry'} _reason
     */
    syncNow(_reason) {
      if (running) {
        again = true
        return running
      }
      running = (async () => {
        try {
          do {
            again = false
            await runOnce()
          } while (again)
        } finally {
          running = null
        }
      })()
      return running
    },
    /** A local change happened: sync 2 s after the last one if anything waits to be pushed. */
    localChanged() {
      if (!inFamily || status.state === 'offline' || status.state === 'removed') return
      if (timer) clearTimer(timer)
      timer = setTimer(async () => {
        timer = null
        const pending = await outboxSize()
        emit({ pending })
        if (pending) await this.syncNow('debounce')
      }, DEBOUNCE_MS)
    },
    /** Resolves once the background photo queue is empty (tests, and callers that need the blobs). */
    photosIdle() {
      return photoRun ?? Promise.resolve()
    },
    stop() {
      for (const id of [timer, retryTimer, photoRetryTimer]) if (id) clearTimer(id)
      timer = retryTimer = photoRetryTimer = null
    },
  }
  return engine
}

// The app's single engine.
/** @type {SyncStatus} */
export const syncStatus = freshStatus()
const appListeners = new Set()
let appEngine = null
let unsubscribeStore = null
let onlineWired = false

/** @param {(s:SyncStatus) => void} fn @returns {() => void} unsubscribe */
export function subscribeSync(fn) {
  appListeners.add(fn)
  return () => appListeners.delete(fn)
}

/**
 * Set up the app's engine (no network): call after the first render. Store mutations and the
 * merge step share the store's queue, store changes feed the debounce, applied plans reload it.
 */
export async function initSync({ db, api, onApplied = reloadFromDb, exclusive = runExclusive }) {
  appEngine?.stop()
  unsubscribeStore?.()
  const engine = createSyncEngine({ db, api, onApplied, exclusive, status: syncStatus, listeners: appListeners })
  appEngine = engine
  await engine.init()
  unsubscribeStore = subscribe(() => engine.localChanged())
  // Back online: whatever waited goes out now, not at the next visit or edit.
  if (!onlineWired && typeof window !== 'undefined') {
    onlineWired = true
    window.addEventListener('online', () => syncNow('online'))
  }
  return engine
}

/** @param {'start'|'visible'|'online'|'pull'|'menu'|'line'|'debounce'|'retry'} reason */
export const syncNow = (reason) => appEngine?.syncNow(reason) ?? Promise.resolve()
