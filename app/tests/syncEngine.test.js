import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  openDb, putTab, addItems, loadAll, getPhoto, setSyncTracking, readOutbox, deleteItems, updateItem, moveItems,
  getTombstones, getMeta,
} from '../src/db.js'
import { createApi, ApiError } from '../src/sync/api.js'
import { createSyncEngine, isProgressOnly, seedSyncStatus, syncStatus } from '../src/sync/engine.js'
import {
  getFamily, createFamily, joinFamily, recoverFamily, restartFromLicence, leaveFamily, resumePending,
  kitOf, parseKit, parseInvite, inviteLink, familyKey,
} from '../src/sync/family.js'
import { decodeRecord } from '../src/sync/records.js'
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
  // A user-visible "done": records synced and the background photo queue drained.
  const sync = async () => { await engine.syncNow('menu'); await engine.photosIdle() }
  return { db, api, engine, sync, applied: () => applied }
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
    expect((await readOutbox(a.db)).map((e) => `${e.kind}:${e.id}`).sort()).toEqual(['item:item-a01', 'item:item-a02', 'kit:family-kit', 'tab:tab-home-a'])
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
    expect(server.families.get(meta.familyId).records.size).toBe(3) // tab, item, kit
  })

  for (const [status, code] of [[429, 'rate-limited'], [503, 'internal']]) {
    it(`a redeem answered ${status} after the server acted stays pending; the next start replays it`, async () => {
      const a = await phone()
      await seed(a, 'tab-home-a', ['item-a01'])
      server.addCode(CODE)
      server.failNext('POST', '/api/redeem', status, code)
      await expect(createFamily(a.db, a.api, { code: CODE, familyName: 'Famiglia Rossi', deviceName: 'Telefono 1' }))
        .rejects.toMatchObject({ status, code })
      const pending = await getFamily(a.db)
      expect(pending.pending).toBeTruthy()
      expect(server.families.has(pending.familyId)).toBe(true) // the code is already spent

      const engine = createSyncEngine({ db: a.db, api: a.api, now: iso }) // the next app start
      await engine.init()
      await engine.syncNow('start')
      const meta = await getFamily(a.db)
      expect(meta.pending).toBeUndefined()
      expect(meta.familyId).toBe(pending.familyId)
      expect(meta.recoverySecret).toBe(pending.recoverySecret)
      expect(engine.status.state).toBe('idle')
      expect(server.families.get(meta.familyId).records.size).toBe(3)
    })
  }

  it('a pending redeem refused for good at a later start is forgotten', async () => {
    const a = await phone()
    server.offline = true
    await expect(createFamily(a.db, a.api, { code: CODE, familyName: 'F', deviceName: 'T' })).rejects.toMatchObject({ status: 0 })
    expect((await getFamily(a.db)).pending).toBeTruthy()
    server.offline = false // the code was never added: 404 bad-code
    await a.engine.syncNow('start')
    expect(await getFamily(a.db)).toBeNull()
    expect(a.engine.status).toMatchObject({ state: 'error', errorCode: 'bad-code' })
  })

  it('an invited phone gets the recovery kit after one sync; a restart replaces it', async () => {
    const a = await phone()
    const meta = await familyOf(a)
    await a.sync()
    const b = await phone()
    expect((await join(a, b)).recoverySecret).toBeNull()
    expect(() => kitOf({ recoverySecret: null })).toThrow('no-kit')
    await b.sync()
    expect(kitOf(await getFamily(b.db))).toBe(kitOf(meta))

    const d = await phone()
    await restartFromLicence(d.db, d.api, { linkToken: server.issueLicenceLink(meta.familyId), familyName: 'Nuova', deviceName: 'Telefono 9' })
    await d.sync()
    const e = await phone()
    await join(d, e)
    await e.sync()
    const kitD = kitOf(await getFamily(d.db))
    expect(kitOf(await getFamily(e.db))).toBe(kitD)
    expect(parseKit(kitD).recoverySecret).not.toBe(meta.recoverySecret)
    // The kit record never reaches the wardrobe and is never tombstoned.
    expect((await snapshot(e)).tabs).toEqual([])
    expect((await getTombstones(e.db)).has('family-kit')).toBe(false)
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
    expect(server.families.get(meta.familyId).records.size).toBe(3) // tab, item, kit
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

  it('join: an empty tab on the joining phone is discarded, never uploaded, and the phone never has zero tabs', async () => {
    const a = await phone()
    await seed(a, 'tab-home-a', ['item-a01'])
    await familyOf(a)
    await a.sync()
    const b = await phone()
    await putTab(b.db, tab('tab-empty-b'))
    await join(a, b)
    expect((await loadAll(b.db)).tabs.map((t) => t.id)).toEqual(['tab-empty-b']) // kept until the first pull
    expect((await readOutbox(b.db)).map((e) => e.id)).not.toContain('tab-empty-b')
    await b.sync()
    await a.sync()
    expect((await loadAll(b.db)).tabs.map((t) => t.id)).toEqual(['tab-home-a'])
    expect(await snapshot(b)).toEqual(await snapshot(a))
    expect((await getTombstones(b.db)).size).toBe(0)
  })

  it('recover: an empty tab on the new phone is discarded the same way', async () => {
    const a = await phone()
    await seed(a, 'tab-home-a', ['item-a01'])
    const meta = await familyOf(a)
    await a.sync()
    const c = await phone()
    await putTab(c.db, tab('tab-empty-c'))
    await recoverFamily(c.db, c.api, kitOf(meta), 'Telefono nuovo')
    expect((await readOutbox(c.db)).map((e) => e.id)).not.toContain('tab-empty-c')
    await c.sync()
    await a.sync()
    expect((await loadAll(c.db)).tabs.map((t) => t.id)).toEqual(['tab-home-a'])
    expect(await snapshot(c)).toEqual(await snapshot(a))
    expect((await loadAll(a.db)).tabs.map((t) => t.id)).toEqual(['tab-home-a'])
  })

  it('join with merge uploads only the non-empty tab of the joining phone', async () => {
    const a = await phone()
    await seed(a, 'tab-home-a', ['item-a01'])
    await familyOf(a)
    await a.sync()
    const b = await phone()
    await putTab(b.db, tab('tab-empty-b', 0))
    await seed(b, 'tab-full-b', ['item-b01'])
    await join(a, b)
    await b.sync()
    await a.sync()
    const ids = (p) => loadAll(p.db).then((d) => d.tabs.map((t) => t.id).sort())
    expect(await ids(a)).toEqual(['tab-full-b', 'tab-home-a'])
    expect(await ids(b)).toEqual(['tab-full-b', 'tab-home-a'])
  })

  it('creating a family still uploads the creator\'s empty tab', async () => {
    const a = await phone()
    await putTab(a.db, tab('tab-empty-a'))
    await familyOf(a)
    expect((await readOutbox(a.db)).map((e) => e.id)).toContain('tab-empty-a')
    await a.sync()
    const b = await phone()
    await join(a, b)
    await b.sync()
    expect((await loadAll(b.db)).tabs.map((t) => t.id)).toEqual(['tab-empty-a'])
  })

  it('re-entering: a local empty tab with the id of an empty family tab is kept on both phones', async () => {
    const a = await phone()
    await putTab(a.db, tab('tab-shared'))
    await seed(a, 'tab-home-a', ['item-a01'])
    await familyOf(a)
    await a.sync()
    const b = await phone()
    await putTab(b.db, tab('tab-shared'))
    await join(a, b)
    await b.sync()
    await a.sync()
    const ids = (p) => loadAll(p.db).then((d) => d.tabs.map((t) => t.id).sort())
    expect(await ids(a)).toEqual(['tab-home-a', 'tab-shared'])
    expect(await ids(b)).toEqual(['tab-home-a', 'tab-shared'])
  })

  it('an item added to the empty tab before the first sync keeps the tab and uploads it', async () => {
    const a = await phone()
    await seed(a, 'tab-home-a', ['item-a01'])
    await familyOf(a)
    await a.sync()
    const b = await phone()
    await putTab(b.db, tab('tab-empty-b'))
    await join(a, b)
    await addItems(b.db, [item('item-b01', 'tab-empty-b')], [photo('ph-item-b01')])
    await b.sync()
    await a.sync()
    expect((await loadAll(a.db)).tabs.map((t) => t.id).sort()).toEqual(['tab-empty-b', 'tab-home-a'])
    expect((await loadAll(a.db)).items.map((i) => i.id).sort()).toEqual(['item-a01', 'item-b01'])
  })

  it('joining with only empty tabs into a family without tabs leaves one tab and tells the UI', async () => {
    const a = await phone()
    await familyOf(a)
    await a.sync()
    const b = await phone()
    await putTab(b.db, tab('tab-e1', 0))
    await putTab(b.db, tab('tab-e2', 1))
    await join(a, b)
    await b.sync()
    expect((await loadAll(b.db)).tabs).toHaveLength(1)
    expect(b.applied()).toBeGreaterThan(0)
    expect(await getMeta(b.db, 'emptyTabsToDrop')).toBeUndefined()
  })

  it('leaving right after joining forgets the tabs to discard', async () => {
    const a = await phone()
    await seed(a, 'tab-home-a', ['item-a01'])
    await familyOf(a)
    const b = await phone()
    await putTab(b.db, tab('tab-empty-b'))
    await join(a, b)
    expect(await getMeta(b.db, 'emptyTabsToDrop')).toEqual(['tab-empty-b'])
    await leaveFamily(b.db, b.api)
    expect(await getMeta(b.db, 'emptyTabsToDrop')).toBeUndefined()
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
    expect(batches.map((b) => b.length)).toEqual([200, 52])
    expect(batches[0].slice(0, 2).sort()).toEqual(['family-kit', 'tab-home-a'])
    const fam = server.families.get(meta.familyId)
    expect(fam.records.size).toBe(252)
    expect(fam.photos.size).toBe(249) // the deleted item's photo was never uploaded
    const b = await phone()
    await join(a, b)
    await b.sync()
    expect((await snapshot(b)).items).toHaveLength(249)
    expect((await getTombstones(b.db)).get('item-0001')).toMatchObject({ kind: 'item' })
  })

  it('photos download in the background: a local edit is pushed while downloads are still running', async () => {
    const a = await phone()
    await seed(a, 'tab-home-a', ['item-a01', 'item-a02', 'item-a03', 'item-a04', 'item-a05'])
    await familyOf(a)
    await a.sync()
    const b = await phone()
    await join(a, b)
    let release
    const gate = new Promise((r) => { release = r })
    let inFlight = 0
    let maxInFlight = 0
    server.beforeHandle = async (method, path) => {
      if (method !== 'GET' || !path.startsWith('/api/photos/')) return
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await gate
      inFlight--
    }
    await b.engine.syncNow('start')
    expect(b.engine.status.state).toBe('idle')
    expect((await snapshot(b)).items).toHaveLength(5)
    expect(await getPhoto(b.db, 'ph-item-a01')).toBeUndefined()

    await updateItem(b.db, 'item-a02', { label: 'subito' }, tick())
    await b.engine.syncNow('debounce') // does not wait for the photo queue
    await a.sync()
    expect((await snapshot(a)).items.find((i) => i.id === 'item-a02').label).toBe('subito')
    expect(maxInFlight).toBe(3)

    release()
    await b.engine.photosIdle()
    expect(await snapshot(b)).toEqual(await snapshot(a))
  })

  it('a 401 after the user left and joined again during the run leaves the new membership alone', async () => {
    const a = await phone()
    await seed(a, 'tab-home-a', ['item-a01'])
    await familyOf(a)
    await a.sync()
    const b = await phone()
    await join(a, b)
    await b.sync()
    await updateItem(b.db, 'item-a01', { label: 'b' }, tick())
    let done = false
    server.onPush = async () => {
      if (done) return
      done = true
      await leaveFamily(b.db, b.api)
      await join(a, b) // back in, new device id and token
      server.failNext('GET', '/api/family', 401, 'unauthorized') // what the old run's next call would see
    }
    await b.sync()
    const meta = await getFamily(b.db)
    expect(meta.removed).toBeUndefined()
    expect(b.engine.status.state).not.toBe('removed')
    await updateItem(b.db, 'item-a01', { label: 'ancora tracciato' }, tick())
    expect((await readOutbox(b.db)).some((e) => e.id === 'item-a01')).toBe(true)
    await b.sync()
    expect(b.engine.status.state).toBe('idle')
    expect(server.devices.has(meta.deviceId)).toBe(true)
  })

  it('a 401 after the user left during the run does not mark anything removed', async () => {
    const a = await phone()
    await seed(a, 'tab-home-a', ['item-a01'])
    await familyOf(a)
    await a.sync()
    const b = await phone()
    await join(a, b)
    await b.sync()
    await updateItem(b.db, 'item-a01', { label: 'b' }, tick())
    server.onPush = async () => { server.onPush = null; await leaveFamily(b.db, b.api) }
    await b.sync() // the next authed call goes out without a token: 401
    expect(await getFamily(b.db)).toBeNull()
    expect(b.engine.status).toMatchObject({ state: 'idle', family: null })
  })

  it('a photo refused as too large: the item is still pushed and the run ends in error (Ruling 21)', async () => {
    const a = await phone()
    await seed(a, 'tab-home-a', ['item-a01'])
    const meta = await familyOf(a)
    server.failNext('PUT', '/api/photos/ph-item-a01', 413, 'limit-photo-size', { act: false })
    await a.sync()
    expect(a.engine.status).toMatchObject({ state: 'error', errorCode: 'limit-photo-size', pending: 0 })
    const fam = server.families.get(meta.familyId)
    expect(fam.records.has('item-a01')).toBe(true)
    expect(fam.photos.size).toBe(0)
    const b = await phone()
    await join(a, b)
    await b.sync()
    expect((await snapshot(b)).items.map((i) => i.id)).toEqual(['item-a01'])
  })

  it('a record too large to send stays queued, the others go out, the run ends in error', async () => {
    const a = await phone()
    await seed(a, 'tab-home-a', ['item-a01', 'item-a02'])
    const meta = await familyOf(a)
    await a.sync()
    await updateItem(a.db, 'item-a01', { label: 'x'.repeat(70 * 1024) }, tick())
    await updateItem(a.db, 'item-a02', { label: 'ok' }, tick())
    await a.sync()
    expect(a.engine.status).toMatchObject({ state: 'error', errorCode: 'limit-record-size', pending: 1 })
    expect((await readOutbox(a.db)).map((e) => e.id)).toEqual(['item-a01'])
    const b = await phone()
    await join(a, b)
    await b.sync()
    const labels = Object.fromEntries((await snapshot(b)).items.map((i) => [i.id, i.label]))
    expect(labels['item-a02']).toBe('ok')
    expect(labels['item-a01']).not.toMatch(/^x+$/)
    // Edited down, it goes out with the next sync.
    await updateItem(a.db, 'item-a01', { label: 'corto' }, tick())
    await a.sync()
    expect(a.engine.status).toMatchObject({ state: 'idle', pending: 0 })
    expect(server.families.get(meta.familyId).records.has('item-a01')).toBe(true)
  })

  it('a photo refused because server storage is full follows the same path, with no retry', async () => {
    const a = await phone()
    await seed(a, 'tab-home-a', ['item-a01'])
    const meta = await familyOf(a)
    server.failNext('PUT', '/api/photos/ph-item-a01', 413, 'limit-storage', { act: false })
    await a.sync()
    expect(a.engine.status).toMatchObject({ state: 'error', errorCode: 'limit-storage', pending: 0 })
    expect(server.families.get(meta.familyId).records.has('item-a01')).toBe(true)
    expect(server.families.get(meta.familyId).photos.size).toBe(0)
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

describe('final review fixes', () => {
  it('createFamily and restartFromLicence refuse to replace a family that is already set up', async () => {
    const a = await phone()
    const meta = await familyOf(a)
    server.addCode('AR-ZZZZ-ZZZZ-ZZZZ')
    await expect(createFamily(a.db, a.api, { code: 'AR-ZZZZ-ZZZZ-ZZZZ', familyName: 'F', deviceName: 'T' })).rejects.toThrow('already-in-family')
    await expect(restartFromLicence(a.db, a.api, { linkToken: server.issueLicenceLink(meta.familyId), familyName: 'F', deviceName: 'T' }))
      .rejects.toThrow('already-in-family')
    expect(await getFamily(a.db)).toEqual(meta)
    expect(server.requests.filter((r) => r.path === '/api/redeem' || r.path === '/api/licence/restart')).toHaveLength(1)
  })

  it('resumePending is single-flight: two callers share one redeem', async () => {
    const a = await phone()
    server.addCode(CODE)
    server.offline = true
    await expect(createFamily(a.db, a.api, { code: CODE, familyName: 'F', deviceName: 'T' })).rejects.toMatchObject({ status: 0 })
    server.offline = false
    const before = server.requests.length
    const [m1, m2] = await Promise.all([resumePending(a.db, a.api), resumePending(a.db, a.api)])
    expect(server.requests.slice(before).filter((r) => r.path === '/api/redeem')).toHaveLength(1)
    expect(m1).toEqual(m2)
    expect(await getFamily(a.db)).toEqual(m1)
  })

  it('a 429 during the first upload is transient: error shown, retried by itself after a minute', async () => {
    const timers = []
    const a = await phone({ setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length }, clearTimer: () => {} })
    await seed(a, 'tab-home-a', ['item-a01'])
    const meta = await familyOf(a)
    server.failNext('PUT', '/api/photos/ph-item-a01', 429, 'rate-limited', { act: false })
    await a.sync()
    expect(a.engine.status).toMatchObject({ state: 'error', errorCode: 'rate-limited', pending: 3 })
    const retry = timers.filter((x) => x.ms === 60000)
    expect(retry).toHaveLength(1)
    await retry[0].fn()
    await a.engine.photosIdle()
    expect(a.engine.status).toMatchObject({ state: 'idle', errorCode: null, pending: 0 })
    expect(server.families.get(meta.familyId).photos.has('ph-item-a01')).toBe(true)
  })

  it('a 429 in the photo download queue is retried by itself after a minute', async () => {
    const a = await phone()
    await seed(a, 'tab-home-a', ['item-a01'])
    await familyOf(a)
    await a.sync()
    const timers = []
    const b = await phone({ setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length }, clearTimer: () => {} })
    await join(a, b)
    server.failNext('GET', '/api/photos/ph-item-a01', 429, 'rate-limited', { act: false })
    await b.sync()
    expect((await snapshot(b)).photos['ph-item-a01']).toBeNull()
    const retry = timers.filter((x) => x.ms === 60000)
    expect(retry).toHaveLength(1)
    await retry[0].fn()
    await b.engine.photosIdle()
    expect((await snapshot(b)).photos['ph-item-a01']).toBe('img-ph-item-a01')
  })

  it('pins the token for a whole run: a leave and join mid-run never sends old-key data into the new family', async () => {
    const a = await phone()
    await familyOf(a)
    await a.sync()
    const c = await phone()
    server.addCode('AR-ZZZZ-ZZZZ-ZZZZ')
    await createFamily(c.db, c.api, { code: 'AR-ZZZZ-ZZZZ-ZZZZ', familyName: 'Altra', deviceName: 'Telefono 3' })
    await c.sync()

    const db = await openDb(`ar-sync-${crypto.randomUUID()}`)
    let switched = false
    const b = { db }
    // Right after the first photo upload of b's run, the user leaves and joins family C.
    const fetchFn = async (url, init) => {
      const res = await server.fetch(url, init)
      if (!switched && init?.method === 'PUT') {
        switched = true
        await leaveFamily(b.db, b.api)
        await join(c, b)
      }
      return res
    }
    b.api = createApi({ fetchFn, getToken: async () => (await getFamily(db))?.token })
    b.engine = createSyncEngine({ db, api: b.api, now: iso, defaultTabName: 'Scheda' })
    await seed(b, 'tab-home-b', ['item-b01'])
    await join(a, b)
    // Every record that reaches family C, as sent (the next run overwrites the same ids).
    const intoC = []
    const cFamily = (await getFamily(c.db)).familyId
    server.onPush = (deviceId, records) => { if (server.devices.get(deviceId).familyId === cFamily) intoC.push(...records) }
    await b.engine.syncNow('menu')
    expect(switched).toBe(true)

    expect(intoC.length).toBeGreaterThan(0) // the next run uploads b's data again, under C's key
    const cMeta = await getFamily(c.db)
    const key = await familyKey(cMeta)
    for (const r of intoC) await expect(decodeRecord(key, cMeta.familyId, r)).resolves.toBeTruthy()
  })
})

describe('progress', () => {
  /** Every progress the engine reported, in order (copies: the status object is reused). */
  const watch = (p) => {
    const runs = []
    const photos = []
    p.engine.subscribe((s) => {
      if (s.progress) runs.push({ ...s.progress })
      photos.push(s.photoDownloads ? { ...s.photoDownloads } : null)
    })
    return { runs, photos, of: (phase) => runs.filter((r) => r.phase === phase) }
  }

  it('photo uploads one by one, then the push, and nothing left once idle', async () => {
    const a = await phone()
    await seed(a, 'tab-home-a', ['item-a01', 'item-a02', 'item-a03'])
    await familyOf(a)
    const seen = watch(a)
    await a.sync()
    expect(seen.of('upload-photos')).toEqual([0, 1, 2, 3].map((done) => ({ phase: 'upload-photos', done, total: 3 })))
    // 3 items + the tab + the kit record, one batch.
    expect(seen.of('push')).toEqual([{ phase: 'push', done: 0, total: 5 }, { phase: 'push', done: 5, total: 5 }])
    // Phases in run order: pull, then photos, then the records.
    const order = seen.runs.map((r) => r.phase).filter((ph, i, all) => all[i - 1] !== ph)
    expect(order).toEqual(['pull', 'upload-photos', 'push'])
    expect(a.engine.status.state).toBe('idle')
    expect(a.engine.status.progress).toBeNull()
    expect(a.engine.status.photoDownloads).toBeNull()
  })

  it('the push counts records batch by batch (200 per batch)', async () => {
    const a = await phone()
    const ids = Array.from({ length: 199 }, (_, i) => `item-b${String(i).padStart(3, '0')}`)
    await seed(a, 'tab-home-a', ids)
    await familyOf(a)
    const seen = watch(a)
    await a.sync()
    expect(seen.of('push')).toEqual([0, 200, 201].map((done) => ({ phase: 'push', done, total: 201 })))
  })

  it('pull pages have no total, decoding counts n of m; background photos count on their own', async () => {
    server = createFakeServer({ clock: () => clockMs, pageSize: 2 })
    const a = await phone()
    await seed(a, 'tab-home-a', ['item-a01', 'item-a02', 'item-a03'])
    await familyOf(a)
    await a.sync()
    const b = await phone()
    await join(a, b)
    const seen = watch(b)
    await b.sync()
    const pull = seen.of('pull')
    // tab + 3 items + kit = 5 records in pages of 2: unknown total while pages come in.
    expect(pull.filter((p) => p.total === null)).toEqual([0, 2, 4].map((done) => ({ phase: 'pull', done, total: null })))
    expect(pull.filter((p) => p.total !== null).at(-1)).toEqual({ phase: 'pull', done: 5, total: 5 })
    expect(pull.findIndex((p) => p.total !== null)).toBeGreaterThan(pull.findLastIndex((p) => p.total === null))
    // The photo queue: 0..3 of 3 (any completion order), then cleared.
    const counts = seen.photos.filter(Boolean)
    expect(counts[0]).toEqual({ done: 0, total: 3 })
    expect(counts.at(-1)).toEqual({ done: 3, total: 3 })
    expect(counts.map((c) => c.done)).toEqual([0, 1, 2, 3])
    expect(seen.photos.at(-1)).toBeNull()
    expect(b.engine.status.progress).toBeNull()
    expect(b.engine.status.photoDownloads).toBeNull()
  })

  it('a pull that brings nothing leaves no "receiving" behind for the rest of the run', async () => {
    const a = await phone()
    await seed(a, 'tab-home-a', ['item-a01'])
    await familyOf(a)
    await a.sync()
    await a.sync() // the first push comes back once: from here pulls are empty
    await updateItem(a.db, 'item-a01', { label: 'changed' })
    const seen = []
    let duringPush = 'unset'
    a.engine.subscribe((s, patch) => {
      if ('progress' in patch) seen.push(s.progress && { ...s.progress })
      if (s.progress?.phase === 'push' && duringPush === 'unset') duringPush = seen.at(-2) // what was shown just before
    })
    await a.sync()
    expect(seen[0]).toEqual({ phase: 'pull', done: 0, total: null })
    expect(seen[1]).toBeNull() // cleared as soon as the empty pull is in
    expect(duringPush).toBeNull()
    expect(a.engine.status.progress).toBeNull()
  })

  it('a failed run clears the progress too', async () => {
    const a = await phone()
    await seed(a, 'tab-home-a', ['item-a01'])
    await familyOf(a)
    server.failNext('POST', '/api/sync', 500, 'internal', { act: false })
    await a.sync()
    expect(a.engine.status.state).toBe('error')
    expect(a.engine.status.progress).toBeNull()
  })

  it('listeners get the patch: progress ticks are told apart from other changes', async () => {
    const a = await phone()
    await seed(a, 'tab-home-a', ['item-a01'])
    await familyOf(a)
    const patches = []
    a.engine.subscribe((_s, patch) => patches.push(patch))
    await a.sync()
    expect(patches.some((p) => isProgressOnly(p))).toBe(true)
    expect(patches.some((p) => p && 'state' in p && !isProgressOnly(p))).toBe(true)
  })

  it('a background poll brings in the other phone\'s changes without showing "syncing"', async () => {
    const a = await phone()
    await seed(a, 'tab-home-a', ['item-a01'])
    await familyOf(a)
    await a.sync()
    const b = await phone()
    await join(a, b)
    await b.sync()
    await updateItem(a.db, 'item-a01', { label: 'da A' }, tick())
    await a.sync()
    const states = []
    b.engine.subscribe((s, patch) => { if (patch && 'state' in patch) states.push(patch.state) })
    await b.engine.syncNow('poll')
    expect(states).toEqual(['idle'])
    expect((await snapshot(b)).items.find((i) => i.id === 'item-a01').label).toBe('da A')
    // A run the user asks for still shows it.
    states.length = 0
    await b.engine.syncNow('menu')
    expect(states[0]).toBe('syncing')
  })
})

describe('active membership flag', () => {
  it('on once in a family, off after leaving, off when removed; never on while a redeem is pending', async () => {
    const a = await phone()
    await seed(a, 'tab-home-a', ['item-a01'])
    server.addCode(CODE)
    server.offline = true
    await expect(createFamily(a.db, a.api, { code: CODE, familyName: 'F', deviceName: 'Telefono 1' })).rejects.toMatchObject({ status: 0 })
    await a.engine.init()
    expect(a.engine.status.member).toBe(false)
    server.offline = false
    await a.sync()
    expect(a.engine.status.member).toBe(true)
    await leaveFamily(a.db, a.api)
    await a.sync()
    expect(a.engine.status.member).toBe(false)

    const b = await phone()
    await seed(b, 'tab-home-b', ['item-b01'])
    await familyOf(b)
    await b.engine.init()
    expect(b.engine.status.member).toBe(true)
    server.removeDevice((await getFamily(b.db)).deviceId)
    await b.sync()
    expect(b.engine.status.state).toBe('removed')
    expect(b.engine.status.member).toBe(false)
  })
})

describe('seedSyncStatus', () => {
  it('marks an active family before the engine runs, and not a pending or absent one', async () => {
    const saved = syncStatus.member
    try {
      const a = await phone()
      await seedSyncStatus(a.db)
      expect(syncStatus.member).toBe(false)
      await familyOf(a)
      await seedSyncStatus(a.db)
      expect(syncStatus.member).toBe(true)
      const b = await phone()
      server.offline = true
      await expect(createFamily(b.db, b.api, { code: 'AR-ZZZZ-ZZZZ-ZZZ1', familyName: 'F', deviceName: 'T' })).rejects.toMatchObject({ status: 0 })
      server.offline = false
      await seedSyncStatus(b.db)
      expect(syncStatus.member).toBe(false)
    } finally { syncStatus.member = saved }
  })
})
