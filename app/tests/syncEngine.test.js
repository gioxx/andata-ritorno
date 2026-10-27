import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  openDb, putTab, addItems, loadAll, getPhoto, setSyncTracking, readOutbox, deleteItems, updateItem, moveItems,
  getTombstones, getMeta,
} from '../src/db.js'
import { createApi, ApiError } from '../src/sync/api.js'
import { createSyncEngine } from '../src/sync/engine.js'
import {
  getFamily, createFamily, joinFamily, recoverFamily, restartFromLicence, leaveFamily, resumePending,
  kitOf, parseKit, parseInvite, inviteLink,
} from '../src/sync/family.js'
import { encrypt, encryptJson, importKey, b64url } from '../src/sync/crypto.js'
import { createFakeServer } from './helpers/fakeServer.js'

const CODE = 'AR-ABCD-EFGH-JK12'
const T0 = '2026-02-01T00:00:00.000Z'
const DAY = 24 * 60 * 60 * 1000
const tab = (id, order = 0) => ({ id, name: id, order, createdAt: T0, updatedAt: T0 })
const item = (id, tabId) => ({
  id, tabId, location: 'school', label: id, photoId: `ph-${id}`, createdAt: T0, movedAt: T0, updatedAt: T0,
})
const photo = (id) => ({ id, blob: new Blob([`img-${id}`], { type: 'image/webp' }), width: 2, height: 3 })

let clockMs
let server
const iso = () => new Date(clockMs).toISOString()
const tick = (ms = 1000) => { clockMs += ms; return iso() }

beforeEach(() => {
  setSyncTracking(false)
  clockMs = Date.parse('2026-03-01T10:00:00.000Z')
  server = createFakeServer({ clock: () => clockMs })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  setSyncTracking(false)
})

/** One simulated phone: its own IndexedDB, API client and engine against the shared fake server. */
async function phone(opts = {}) {
  const db = await openDb(`ar-sync-${crypto.randomUUID()}`)
  const api = createApi({ fetchFn: server.fetch, getToken: async () => (await getFamily(db))?.token })
  let applied = 0
  const engine = createSyncEngine({ db, api, now: iso, defaultTabName: 'Scheda', onApplied: () => { applied++ }, ...opts })
  return { db, api, engine, sync: () => engine.syncNow('menu'), applied: () => applied }
}

async function seed(p, tabId, ids) {
  await putTab(p.db, tab(tabId))
  await addItems(p.db, ids.map((i) => item(i, tabId)), ids.map((i) => photo(`ph-${i}`)))
}

async function familyOf(p, name = 'Famiglia Rossi') {
  server.addCode(CODE)
  await createFamily(p.db, p.api, { code: CODE, familyName: name, deviceName: 'Telefono 1' })
  return getFamily(p.db)
}

async function join(owner, p, { mode = 'merge', deviceName = 'Telefono 2' } = {}) {
  const meta = await getFamily(owner.db)
  const { token } = await owner.api.createInvite()
  const inv = parseInvite(inviteLink(token, meta, 'https://ar.example'))
  await joinFamily(p.db, p.api, { ...inv, deviceName, mode })
  return getFamily(p.db)
}

/** Everything a user could see, in a stable order, with photo contents. */
async function snapshot(p) {
  const { tabs, categories, items } = await loadAll(p.db)
  items.sort((a, b) => (a.id < b.id ? -1 : 1))
  const photos = {}
  for (const it of items) photos[it.photoId] = (await (await getPhoto(p.db, it.photoId))?.text()) ?? null
  return { tabs, categories, items, photos }
}

const pushes = () => server.requests.filter((r) => r.method === 'POST' && r.path === '/api/sync').length

describe('family orchestration', () => {
  it('createFamily redeems, stores the family and queues every local record', async () => {
    const a = await phone()
    await seed(a, 'tab-home-a', ['item-a01', 'item-a02'])
    const meta = await familyOf(a)
    expect(meta).toMatchObject({ licenceKind: 'family', cursor: 0, lastSyncAt: null, deviceLimit: 4 })
    expect(meta.pending).toBeUndefined()
    expect(meta.token).toMatch(/^tok_/)
    expect(b64url.decode(meta.keyRaw)).toHaveLength(32)
    expect((await readOutbox(a.db)).map((e) => `${e.kind}:${e.id}`).sort()).toEqual(['item:item-a01', 'item:item-a02', 'tab:tab-home-a'])
  })

  it('a lost redeem response is retried once with the same body and the replayed token is kept', async () => {
    const a = await phone()
    await seed(a, 'tab-home-a', ['item-a01'])
    server.loseNextResponse('POST', '/api/redeem')
    const meta = await familyOf(a)
    expect(server.requests.filter((r) => r.path === '/api/redeem')).toHaveLength(2)
    expect(server.devices.get(meta.deviceId).token).toBe(meta.token)
    await a.sync()
    expect(a.engine.status.state).toBe('idle')
  })

  it('a redeem that never got an answer stays pending and is finished by resumePending', async () => {
    const a = await phone()
    await seed(a, 'tab-home-a', ['item-a01'])
    server.addCode(CODE)
    server.offline = true
    await expect(createFamily(a.db, a.api, { code: CODE, familyName: 'Famiglia Rossi', deviceName: 'Telefono 1' }))
      .rejects.toMatchObject({ status: 0, code: 'offline' })
    const pending = await getFamily(a.db)
    expect(pending.pending).toBeTruthy()
    expect(pending.recoverySecret).toBeTruthy()

    // The next start finishes it, even if this time the server had already acted on it.
    server.offline = false
    server.loseNextResponse('POST', '/api/redeem')
    await resumePending(a.db, a.api)
    const meta = await getFamily(a.db)
    expect(meta.pending).toBeUndefined()
    expect(meta.familyId).toBe(pending.familyId)
    await a.sync()
    expect(server.families.get(meta.familyId).records.size).toBe(2)
  })

  it('a refused redeem leaves no family behind', async () => {
    const a = await phone()
    await expect(createFamily(a.db, a.api, { code: CODE, familyName: 'F', deviceName: 'T' })).rejects.toMatchObject({ status: 404, code: 'bad-code' })
    expect(await getFamily(a.db)).toBeNull()
  })

  it('kit and invite strings round-trip; malformed ones are refused', async () => {
    const a = await phone()
    const meta = await familyOf(a)
    const kit = kitOf(meta)
    expect(kit).toBe(`ARKIT1.${meta.familyId}.${meta.keyRaw}.${meta.recoverySecret}`)
    expect(parseKit(`  ${kit}\n`)).toEqual({ familyId: meta.familyId, keyRaw: meta.keyRaw, recoverySecret: meta.recoverySecret })
    for (const bad of ['', 'ARKIT2.a.b.c', `ARKIT1.${meta.familyId}.short.${meta.recoverySecret}`, `ARKIT1.${meta.familyId}.${meta.keyRaw}`]) {
      expect(() => parseKit(bad)).toThrow('bad-kit')
    }
    const link = inviteLink('invite_tok', meta, 'https://ar.example')
    expect(link).toBe(`https://ar.example/join#invite_tok.${meta.familyId}.${meta.keyRaw}`)
    const parsed = { inviteToken: 'invite_tok', familyId: meta.familyId, keyRaw: meta.keyRaw }
    expect(parseInvite(link)).toEqual(parsed)
    expect(parseInvite(`#invite_tok.${meta.familyId}.${meta.keyRaw}`)).toEqual(parsed)
    expect(parseInvite(`invite_tok.${meta.familyId}.${meta.keyRaw}`)).toEqual(parsed)
    for (const bad of ['', 'https://ar.example/join', `x.${meta.familyId}.AAAA`]) expect(() => parseInvite(bad)).toThrow('bad-invite')
  })

  it('recoverFamily brings the data back on a new phone with the kit', async () => {
    const a = await phone()
    await seed(a, 'tab-home-a', ['item-a01', 'item-a02'])
    const meta = await familyOf(a)
    await a.sync()
    const c = await phone()
    await recoverFamily(c.db, c.api, kitOf(meta), 'Telefono nuovo')
    await c.sync()
    expect(await snapshot(c)).toEqual(await snapshot(a))
    expect((await getFamily(c.db)).recoverySecret).toBe(meta.recoverySecret)
  })

  it('recoverFamily into a full family reports the devices with their names decrypted', async () => {
    const a = await phone()
    const meta = await familyOf(a)
    for (let i = 2; i <= 4; i++) {
      tick() // the server lists devices by creation time
      await join(a, await phone(), { deviceName: `Telefono ${i}` })
    }
    const c = await phone()
    const err = await recoverFamily(c.db, c.api, kitOf(meta), 'Telefono 5').catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err.code).toBe('family-full')
    expect(err.extra.devices.map((d) => d.name)).toEqual(['Telefono 1', 'Telefono 2', 'Telefono 3', 'Telefono 4'])
    expect(await getFamily(c.db)).toBeNull()
  })

  it('restartFromLicence starts a new family; old devices are then removed', async () => {
    const a = await phone()
    const old = await familyOf(a)
    await a.sync()
    const d = await phone()
    await seed(d, 'tab-home-d', ['item-d01'])
    await restartFromLicence(d.db, d.api, { linkToken: server.issueLicenceLink(old.familyId), familyName: 'Nuova', deviceName: 'Telefono 9' })
    const meta = await getFamily(d.db)
    expect(meta.familyId).not.toBe(old.familyId)
    expect(meta.deviceLimit).toBe(4)
    await d.sync()
    expect(d.engine.status.family.name).toBe('Nuova')
    expect(server.families.get(meta.familyId).records.size).toBe(2)
    await a.sync()
    expect(a.engine.status.state).toBe('removed')
  })

  it('leaveFamily removes the device, forgets the family and keeps local data', async () => {
    const a = await phone()
    await seed(a, 'tab-home-a', ['item-a01'])
    await familyOf(a)
    const b = await phone()
    const bMeta = await join(a, b)
    await b.sync()
    const before = await snapshot(b)
    expect(await leaveFamily(b.db, b.api)).toEqual({ purged: false })
    expect(await getFamily(b.db)).toBeNull()
    expect(server.devices.has(bMeta.deviceId)).toBe(false)
    expect(await snapshot(b)).toEqual(before)
    expect(await readOutbox(b.db)).toEqual([])
    await updateItem(b.db, 'item-a01', { label: 'solo qui' }, tick())
    expect(await readOutbox(b.db)).toEqual([]) // no longer tracked
    const n = server.requests.length
    await b.sync()
    expect(server.requests.length).toBe(n) // zero network outside a family
  })
})

describe('sync engine (two phones)', () => {
  it('B joins with merge: both end with the union of items and photos', async () => {
    const a = await phone()
    await seed(a, 'tab-home-a', ['item-a01', 'item-a02', 'item-a03'])
    await familyOf(a)
    await a.sync()
    const b = await phone()
    await seed(b, 'tab-home-b', ['item-b01'])
    await join(a, b)
    await b.sync()
    await a.sync()
    const sa = await snapshot(a)
    expect(sa.items).toHaveLength(4)
    expect(sa.tabs).toHaveLength(2)
    expect(Object.values(sa.photos)).not.toContain(null)
    expect(await snapshot(b)).toEqual(sa)
    // Blob type and size survive the round trip.
    const blob = await getPhoto(b.db, 'ph-item-a01')
    expect(blob.type).toBe('image/webp')
    expect((await b.db.get('photos', 'ph-item-a01'))).toMatchObject({ width: 2, height: 3 })
    expect(b.engine.status.lastChanges).toEqual({ count: 4, by: (await getFamily(a.db)).deviceId })
    expect(b.applied()).toBeGreaterThan(0)
  })

  it('B joins with replace: B ends with the family data only', async () => {
    const a = await phone()
    await seed(a, 'tab-home-a', ['item-a01', 'item-a02', 'item-a03'])
    await familyOf(a)
    await a.sync()
    const b = await phone()
    await seed(b, 'tab-home-b', ['item-b01'])
    await join(a, b, { mode: 'replace' })
    await b.sync()
    const sb = await snapshot(b)
    expect(sb.items.map((i) => i.id)).toEqual(['item-a01', 'item-a02', 'item-a03'])
    expect(sb).toEqual(await snapshot(a))
  })

  it('Review Focus 1: an offline move newer than a deletion survives; fields merge; then it is quiet', async () => {
    const a = await phone()
    await seed(a, 'tab-home-a', ['item-xxx1', 'item-yyy1'])
    await familyOf(a)
    await a.sync()
    const b = await phone()
    await join(a, b)
    await b.sync()

    server.offline = true
    const t1 = tick()
    await deleteItems(a.db, ['item-xxx1'], t1)
    await updateItem(a.db, 'item-yyy1', { label: 'etichetta A' }, t1)
    const t2 = tick()
    await moveItems(b.db, ['item-xxx1'], 'home', t2)
    await moveItems(b.db, ['item-yyy1'], 'home', t2)
    await a.sync()
    expect(a.engine.status.state).toBe('offline')

    server.offline = false
    await a.sync()
    await b.sync()
    await a.sync()
    for (const p of [a, b]) {
      const s = await snapshot(p)
      expect(s.items.find((i) => i.id === 'item-xxx1')).toMatchObject({ location: 'home', movedAt: t2 })
      expect(s.items.find((i) => i.id === 'item-yyy1')).toMatchObject({ label: 'etichetta A', location: 'home' })
      expect(s.photos['ph-item-xxx1']).toBe('img-ph-item-xxx1')
      expect(await readOutbox(p.db)).toEqual([])
    }
    expect(await snapshot(b)).toEqual(await snapshot(a))

    const n = pushes()
    await a.sync()
    await b.sync()
    await a.sync()
    expect(pushes()).toBe(n)
  })

  it('Review Focus 3: a removed device stops syncing and keeps its data', async () => {
    const a = await phone()
    await seed(a, 'tab-home-a', ['item-a01'])
    await familyOf(a)
    await a.sync()
    const b = await phone()
    const bMeta = await join(a, b)
    await b.sync()
    const before = await snapshot(b)
    server.removeDevice(bMeta.deviceId)
    await b.sync()
    expect(b.engine.status.state).toBe('removed')
    expect((await getFamily(b.db)).removed).toBe(true)
    const n = server.requests.length
    await b.engine.syncNow('start')
    await b.engine.syncNow('visible')
    expect(server.requests.length).toBe(n)
    expect(b.engine.status.state).toBe('removed')
    expect(await snapshot(b)).toEqual(before)
    // A fresh engine (next app start) stays quiet too.
    const again = createSyncEngine({ db: b.db, api: b.api, now: iso })
    await again.init()
    await again.syncNow('start')
    expect(server.requests.length).toBe(n)
    expect(again.status.state).toBe('removed')
  })

  it('offline: the outbox is kept and pushed by the next online sync', async () => {
    const a = await phone()
    await seed(a, 'tab-home-a', ['item-a01'])
    await familyOf(a)
    await a.sync()
    const b = await phone()
    await join(a, b)
    await b.sync()

    await updateItem(a.db, 'item-a01', { label: 'nuovo' }, tick())
    server.offline = true
    await a.sync()
    expect(a.engine.status).toMatchObject({ state: 'offline', pending: 1 })
    expect(await readOutbox(a.db)).toHaveLength(1)
    server.offline = false
    await a.sync()
    expect(a.engine.status).toMatchObject({ state: 'idle', pending: 0, errorCode: null })
    await b.sync()
    expect((await snapshot(b)).items[0].label).toBe('nuovo')
  })

  it('records that fail to decrypt or parse are skipped, the rest applied', async () => {
    const a = await phone()
    await seed(a, 'tab-home-a', ['item-a01', 'item-a02'])
    const meta = await familyOf(a)
    await a.sync()
    const key = await importKey(b64url.decode(meta.keyRaw))
    server.injectRecord(meta.familyId, 'garbage-0001', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
    // Valid ciphertext, but bound to another record id (a swapped blob).
    server.injectRecord(meta.familyId, 'swapped-0001', await encryptJson(key, `${meta.familyId}:other-0001`, { k: 'item', v: item('swapped-0001', 'tab-home-a') }))
    // Authentic, but not JSON.
    server.injectRecord(meta.familyId, 'notjson-0001', b64url.encode(await encrypt(key, `${meta.familyId}:notjson-0001`, new TextEncoder().encode('{nope'))))
    const b = await phone()
    await join(a, b)
    await b.sync()
    expect((await snapshot(b)).items.map((i) => i.id)).toEqual(['item-a01', 'item-a02'])
    expect(b.engine.status.state).toBe('idle')
    expect(console.warn).toHaveBeenCalledTimes(3)
  })

  it('merges once after every page: an item never becomes an orphan because its tab is on a later page', async () => {
    server = createFakeServer({ clock: () => clockMs, pageSize: 2 })
    const a = await phone()
    await seed(a, 'tab-home-a', ['item-a01', 'item-a02'])
    await familyOf(a)
    await a.sync()
    await putTab(a.db, { ...tab('tab-home-a'), name: 'Rinominata', updatedAt: tick() }) // tab now sorts after its items
    await a.sync()
    const b = await phone()
    await seed(b, 'tab-home-b', ['item-b01'])
    await join(a, b)
    await b.sync()
    const sb = await snapshot(b)
    expect(sb.items.filter((i) => i.tabId === 'tab-home-a').map((i) => i.id)).toEqual(['item-a01', 'item-a02'])
    expect(b.engine.status.movedOrphans).toBe(0)
    expect(server.requests.filter((r) => r.method === 'GET' && r.path === '/api/sync').length).toBeGreaterThan(2)
  })

  it('an edit made while a push is in flight is pushed next time, not lost', async () => {
    const a = await phone()
    await seed(a, 'tab-home-a', ['item-a01'])
    await familyOf(a)
    let edited = false
    server.onPush = async () => {
      if (edited) return
      edited = true
      await updateItem(a.db, 'item-a01', { label: 'durante' }, tick())
    }
    await a.sync()
    expect((await readOutbox(a.db)).map((e) => e.id)).toEqual(['item-a01'])
    expect(a.engine.status.pending).toBe(1)
    await a.sync()
    const b = await phone()
    await join(a, b)
    await b.sync()
    expect((await snapshot(b)).items[0].label).toBe('durante')
  })

  it('pushes tabs, then categories, then items in batches of 200; tombstones for deleted records', async () => {
    const a = await phone()
    const ids = Array.from({ length: 250 }, (_, i) => `item-${String(i).padStart(4, '0')}`)
    await putTab(a.db, tab('tab-home-a'))
    await addItems(a.db, ids.map((i) => item(i, 'tab-home-a')), ids.map((i) => photo(`ph-${i}`)))
    const meta = await familyOf(a)
    await deleteItems(a.db, ['item-0001'], tick())
    const batches = []
    server.onPush = (_dev, records) => { batches.push(records.map((r) => r.rid)) }
    await a.sync()
    expect(batches.map((b) => b.length)).toEqual([200, 51])
    expect(batches[0][0]).toBe('tab-home-a')
    const fam = server.families.get(meta.familyId)
    expect(fam.records.size).toBe(251)
    expect(fam.photos.size).toBe(249) // the deleted item's photo was never uploaded
    const b = await phone()
    await join(a, b)
    await b.sync()
    expect((await snapshot(b)).items).toHaveLength(249)
    expect((await getTombstones(b.db)).get('item-0001')).toMatchObject({ kind: 'item' })
  })

  it('after a sync the family view and device names are decrypted (Ruling 3)', async () => {
    const a = await phone()
    const meta = await familyOf(a)
    const b = await phone()
    tick()
    await join(a, b, { deviceName: 'Telefono 2' })
    await a.sync()
    const { family, deviceNames } = a.engine.status
    expect(family).toMatchObject({ name: 'Famiglia Rossi', deviceLimit: 4 })
    expect(family.devices.map((d) => [d.name, d.isThis])).toEqual([['Telefono 1', true], ['Telefono 2', false]])
    expect(family.devices[0]).toEqual(expect.objectContaining({ id: meta.deviceId, createdAt: expect.any(String), lastSeenAt: expect.any(String) }))
    expect(deviceNames.get(meta.deviceId)).toBe('Telefono 1')
    expect(a.engine.status.lastSyncAt).toBe(iso())
    expect((await getFamily(a.db)).lastSyncAt).toBe(iso())
  })

  it('deletes server photos only after 30 days unreferenced', async () => {
    const a = await phone()
    await seed(a, 'tab-home-a', ['item-a01', 'item-a02'])
    const meta = await familyOf(a)
    await a.sync()
    await deleteItems(a.db, ['item-a01'], tick())
    await a.sync()
    const photos = () => [...server.families.get(meta.familyId).photos.keys()].sort()
    expect(photos()).toEqual(['ph-item-a01', 'ph-item-a02'])
    expect(Object.keys(await getMeta(a.db, 'orphanSeen'))).toEqual(['ph-item-a01'])
    tick(29 * DAY)
    await a.sync()
    expect(photos()).toEqual(['ph-item-a01', 'ph-item-a02'])
    tick(2 * DAY)
    await a.sync()
    expect(photos()).toEqual(['ph-item-a02'])
    expect(await getMeta(a.db, 'orphanSeen')).toEqual({})
  })

  it('single-flight: a call while running schedules exactly one more run', async () => {
    const a = await phone()
    await seed(a, 'tab-home-a', ['item-a01'])
    await familyOf(a)
    const runs = () => server.requests.filter((r) => r.path === '/api/family').length
    const p1 = a.engine.syncNow('start')
    const p2 = a.engine.syncNow('visible')
    const p3 = a.engine.syncNow('pull')
    await Promise.all([p1, p2, p3])
    expect(runs()).toBe(2)
  })

  it('debounces a sync 2 s after a local change while the outbox is non-empty', async () => {
    const timers = []
    const a = await phone({ setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length }, clearTimer: () => {} })
    await seed(a, 'tab-home-a', ['item-a01'])
    await familyOf(a)
    await a.engine.init()
    await a.sync()
    await updateItem(a.db, 'item-a01', { label: 'x' }, tick())
    a.engine.localChanged()
    expect(timers.at(-1).ms).toBe(2000)
    const n = pushes()
    await timers.at(-1).fn()
    expect(pushes()).toBe(n + 1)

    // Nothing waiting: the timer fires but makes no request.
    a.engine.localChanged()
    const m = server.requests.length
    await timers.at(-1).fn()
    expect(server.requests.length).toBe(m)

    // Offline: no debounce at all.
    server.offline = true
    await updateItem(a.db, 'item-a01', { label: 'y' }, tick())
    await a.sync()
    const count = timers.length
    a.engine.localChanged()
    expect(timers.length).toBe(count)
  })

  it('a device outside any family makes no requests', async () => {
    const a = await phone()
    await seed(a, 'tab-home-a', ['item-a01'])
    await a.engine.init()
    await a.sync()
    a.engine.localChanged()
    expect(server.requests).toEqual([])
    expect(a.engine.status.state).toBe('idle')
  })
})
