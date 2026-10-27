// In-memory stand-in for the Worker API (worker/src/*.js), for app tests. Same routes, status codes,
// error codes, validation, paging and replay rules; ciphertext is stored as received (no crypto
// checks), secrets are compared by their SHA-256 hex like the real server.
import { sha256Hex } from '../../src/sync/crypto.js'

const ID = /^[A-Za-z0-9_-]{8,64}$/
const ENC = /^[A-Za-z0-9_-]{1,4096}$/
const HEX64 = /^[0-9a-f]{64}$/
const B64URL = /^[A-Za-z0-9_-]+$/
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const isSecret = (s) => typeof s === 'string' && s.length > 0 && s.length <= 128
const INVITE_TTL_MS = 10 * 60 * 1000
const LINK_TTL_MS = 30 * 60 * 1000
const MAX_PUSH = 200
const MAX_RECORDS = 10000
const MAX_DATA = 64 * 1024
const MAX_PHOTO = 3 * 1024 * 1024
const MAX_PHOTOS = 2000

class HttpError extends Error {
  constructor(status, code, extra) {
    super(code)
    Object.assign(this, { status, code, extra })
  }
}
const fail = (status, code, extra) => { throw new HttpError(status, code, extra) }
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } })

function normaliseCode(input) {
  if (typeof input !== 'string' || input.length > 64) return null
  let s = input.toUpperCase().replace(/[\s-]/g, '')
  if (s.length === 14 && s.startsWith('AR')) s = s.slice(2)
  s = s.replace(/O/g, '0').replace(/[IL]/g, '1')
  if (s.length !== 12 || [...s].some((c) => !ALPHABET.includes(c))) return null
  return `AR-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`
}

let tokenSeq = 0
const newToken = () => `tok_${++tokenSeq}_${crypto.randomUUID()}`

/**
 * @param {{ clock?: () => number, pageSize?: number }} [opts] clock in ms (default Date.now)
 */
export function createFakeServer({ clock = () => Date.now(), pageSize = 500 } = {}) {
  const nowIso = () => new Date(clock()).toISOString()
  const codes = new Map() // normalised code -> {kind, redeemedAt, licenceId}
  const licences = new Map() // id -> {id, baseLimit, extraSlots, familyId}
  const families = new Map() // id -> {id, licenceId, nameEnc, recoveryHash, seq, records: Map, photos: Map}
  const devices = new Map() // id -> {id, familyId, token, nameEnc, createdAt, lastSeenAt}
  const invites = new Map() // token -> {familyId, expiresAt, usedAt}
  const links = new Map() // token -> {licenceId, expiresAt, usedAt}
  let lose = null

  const server = {
    /** When true every request fails like a dropped connection. */
    offline: false,
    /** @type {{method:string, path:string}[]} every request that reached the server */
    requests: [],
    /** Called with (deviceId, records) before a push is stored: lets a test act mid-push. */
    onPush: null,
    families,
    devices,

    addCode(code, kind = 'family') {
      codes.set(normaliseCode(code), { kind, redeemedAt: null, licenceId: null })
    },
    /** A licence-recovery link for the licence powering `familyId` (what the email would carry). */
    issueLicenceLink(familyId) {
      const token = newToken()
      links.set(token, { licenceId: families.get(familyId).licenceId, expiresAt: clock() + LINK_TTL_MS, usedAt: null })
      return token
    },
    /** Remove a device as another family member would. */
    removeDevice(deviceId) {
      devices.delete(deviceId)
    },
    /** Store raw data as a record (e.g. something the family key cannot decrypt). */
    injectRecord(familyId, rid, data) {
      const f = families.get(familyId)
      f.records.set(rid, { rid, seq: ++f.seq, data })
    },
    /** The request after which the response is lost (the server still acted on it). */
    loseNextResponse(method, path) {
      lose = { method, path }
    },
    fetch: async (url, init = {}) => {
      if (server.offline) throw new TypeError('Failed to fetch')
      const u = new URL(url, 'https://fake.test')
      const method = (init.method ?? 'GET').toUpperCase()
      server.requests.push({ method, path: u.pathname })
      let res
      try {
        res = await handle(method, u, init)
      } catch (e) {
        if (!(e instanceof HttpError)) throw e
        res = json({ error: e.code, ...e.extra }, e.status)
      }
      if (lose && lose.method === method && lose.path === u.pathname) {
        lose = null
        throw new TypeError('Failed to fetch')
      }
      return res
    },
  }

  const limitOf = (f) => {
    const l = licences.get(f.licenceId)
    return l.baseLimit + l.extraSlots
  }
  const devicesOf = (familyId) =>
    [...devices.values()]
      .filter((d) => d.familyId === familyId)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1))
  const publicDevices = (familyId) =>
    devicesOf(familyId).map((d) => ({ id: d.id, nameEnc: d.nameEnc, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt }))

  function auth(init) {
    const m = /^Bearer (\S+)$/.exec(new Headers(init.headers).get('authorization') ?? '')
    const dev = m && [...devices.values()].find((d) => d.token === m[1])
    if (!dev) fail(401, 'unauthorized')
    dev.lastSeenAt = nowIso()
    return dev
  }
  function body(init) {
    try { return JSON.parse(init.body) } catch { return fail(400, 'bad-request') }
  }
  function rotate(dev) {
    dev.token = newToken()
    dev.lastSeenAt = nowIso()
    return dev.token
  }
  function addDevice(familyId, deviceId, nameEnc) {
    const at = nowIso()
    const dev = { id: deviceId, familyId, token: newToken(), nameEnc, createdAt: at, lastSeenAt: at }
    devices.set(deviceId, dev)
    return dev
  }
  function purge(familyId) {
    for (const d of devicesOf(familyId)) devices.delete(d.id)
    for (const [t, i] of invites) if (i.familyId === familyId) invites.delete(t)
    families.delete(familyId)
  }
  function newFamilyFields(b) {
    const ok = ID.test(b?.familyId ?? '') && ID.test(b?.deviceId ?? '') && ENC.test(b?.familyNameEnc ?? '') &&
      ENC.test(b?.deviceNameEnc ?? '') && HEX64.test(b?.recoveryHash ?? '')
    if (!ok) fail(400, 'bad-request')
    return b
  }
  function createFamily(licenceId, f) {
    families.set(f.familyId, {
      id: f.familyId, licenceId, nameEnc: f.familyNameEnc, recoveryHash: f.recoveryHash, seq: 0, records: new Map(), photos: new Map(),
    })
    licences.get(licenceId).familyId = f.familyId
    const dev = addDevice(f.familyId, f.deviceId, f.deviceNameEnc)
    return json({ token: dev.token, deviceLimit: limitOf(families.get(f.familyId)) })
  }
  /** A redeem/restart retried after a lost response: same family, recovery hash and device → fresh token. */
  function replay(licenceId, f) {
    const l = licenceId && licences.get(licenceId)
    const fam = l && l.familyId === f.familyId && families.get(f.familyId)
    const dev = fam && fam.recoveryHash === f.recoveryHash && devices.get(f.deviceId)
    if (!dev || dev.familyId !== f.familyId) return null
    return json({ token: rotate(dev), deviceLimit: limitOf(fam) })
  }
  async function checkKit(b) {
    if (!ID.test(b?.familyId ?? '') || !ID.test(b?.deviceId ?? '')) fail(400, 'bad-request')
    if (!isSecret(b.recoverySecret)) fail(403, 'bad-kit')
    const fam = families.get(b.familyId)
    if (!fam || fam.recoveryHash !== (await sha256Hex(b.recoverySecret))) fail(403, 'bad-kit')
    return fam
  }

  async function handle(method, u, init) {
    const route = `${method} ${u.pathname}`
    const photo = /^\/api\/photos\/([^/]+)$/.exec(u.pathname)
    const devPath = /^\/api\/devices\/([^/]+)$/.exec(u.pathname)

    if (route === 'POST /api/redeem') {
      const b = body(init)
      const f = newFamilyFields(b)
      const code = codes.get(normaliseCode(b.code))
      if (!code) fail(404, 'bad-code')
      if (code.kind === 'slot') fail(409, 'code-is-slot')
      if (code.redeemedAt) return replay(code.licenceId, f) ?? fail(409, 'code-used')
      const licenceId = crypto.randomUUID()
      Object.assign(code, { redeemedAt: nowIso(), licenceId })
      licences.set(licenceId, { id: licenceId, baseLimit: 4, extraSlots: 0, familyId: null })
      return createFamily(licenceId, f)
    }
    if (route === 'POST /api/slot') {
      const dev = auth(init)
      const code = codes.get(normaliseCode(body(init)?.code))
      if (!code) fail(404, 'bad-code')
      if (code.kind === 'family') fail(409, 'code-is-family')
      if (code.redeemedAt) fail(409, 'code-used')
      const fam = families.get(dev.familyId)
      Object.assign(code, { redeemedAt: nowIso(), licenceId: fam.licenceId })
      licences.get(fam.licenceId).extraSlots++
      return json({ deviceLimit: limitOf(fam) })
    }
    if (route === 'GET /api/unlock/session') fail(404, 'bad-session')
    if (route === 'GET /api/family') {
      const dev = auth(init)
      const fam = families.get(dev.familyId)
      return json({ familyId: fam.id, familyNameEnc: fam.nameEnc, deviceLimit: limitOf(fam), you: dev.id, devices: publicDevices(fam.id) })
    }
    if (route === 'POST /api/invites') {
      const dev = auth(init)
      const fam = families.get(dev.familyId)
      const used = devicesOf(fam.id).length
      if (used >= limitOf(fam)) fail(409, 'family-full')
      const token = newToken()
      const expiresAt = new Date(clock() + INVITE_TTL_MS).toISOString()
      invites.set(token, { familyId: fam.id, expiresAt, usedAt: null })
      return json({ token, expiresAt, used, limit: limitOf(fam) })
    }
    if (route === 'GET /api/invites/info') {
      const inv = invites.get(u.searchParams.get('t'))
      if (!inv || inv.usedAt || inv.expiresAt <= nowIso()) fail(410, 'invite-expired')
      const fam = families.get(inv.familyId)
      return json({ familyNameEnc: fam.nameEnc, used: devicesOf(fam.id).length, limit: limitOf(fam) })
    }
    if (route === 'POST /api/join') {
      const b = body(init)
      if (!ID.test(b?.deviceId ?? '') || !ENC.test(b?.deviceNameEnc ?? '')) fail(400, 'bad-request')
      const inv = isSecret(b.inviteToken) && invites.get(b.inviteToken)
      if (!inv || inv.expiresAt <= nowIso()) fail(410, 'invite-expired')
      const fam = families.get(inv.familyId)
      if (inv.usedAt) {
        const dev = devices.get(b.deviceId)
        if (!dev || dev.familyId !== inv.familyId || dev.createdAt !== inv.usedAt) fail(410, 'invite-expired')
        return json({ token: rotate(dev), deviceLimit: limitOf(fam) })
      }
      if (devicesOf(fam.id).length >= limitOf(fam)) fail(409, 'family-full')
      const dev = addDevice(fam.id, b.deviceId, b.deviceNameEnc)
      inv.usedAt = dev.createdAt
      return json({ token: dev.token, deviceLimit: limitOf(fam) })
    }
    if (devPath && method === 'DELETE') {
      const dev = auth(init)
      const target = devices.get(decodeURIComponent(devPath[1]))
      if (!target || target.familyId !== dev.familyId) fail(404, 'not-found')
      devices.delete(target.id)
      const purged = target.id === dev.id && devicesOf(dev.familyId).length === 0
      if (purged) {
        licences.get(families.get(dev.familyId).licenceId).familyId = null
        purge(dev.familyId)
      }
      return json({ purged })
    }
    if (route === 'POST /api/recover') {
      const b = body(init)
      if (!ENC.test(b?.deviceNameEnc ?? '')) fail(400, 'bad-request')
      const fam = await checkKit(b)
      const known = devices.get(b.deviceId)
      if (known && known.familyId === fam.id) return json({ token: rotate(known), deviceLimit: limitOf(fam) })
      if (devicesOf(fam.id).length >= limitOf(fam)) fail(409, 'family-full', { devices: publicDevices(fam.id) })
      const dev = addDevice(fam.id, b.deviceId, b.deviceNameEnc)
      return json({ token: dev.token, deviceLimit: limitOf(fam) })
    }
    if (route === 'POST /api/recover/remove-device') {
      const b = body(init)
      const fam = await checkKit(b)
      if (devices.get(b.deviceId)?.familyId === fam.id) devices.delete(b.deviceId)
      return json({ ok: true })
    }
    if (route === 'POST /api/licence/email') {
      const b = body(init)
      if (typeof b?.email !== 'string' || b.email.length > 320) fail(400, 'bad-request')
      return new Response(null, { status: 202 })
    }
    if (route === 'POST /api/licence/restart') {
      const b = body(init)
      const f = newFamilyFields(b)
      const link = isSecret(b.linkToken) && links.get(b.linkToken)
      if (!link) fail(410, 'link-expired')
      if (link.usedAt || link.expiresAt <= clock()) return replay(link.licenceId, f) ?? fail(410, 'link-expired')
      const licence = licences.get(link.licenceId)
      if (f.familyId === licence.familyId) fail(400, 'bad-request')
      for (const l of links.values()) if (l.licenceId === link.licenceId) l.usedAt ??= clock()
      if (licence.familyId) purge(licence.familyId)
      return createFamily(link.licenceId, f)
    }
    if (route === 'GET /api/sync') {
      const dev = auth(init)
      const raw = u.searchParams.get('since') ?? '0'
      if (!/^\d+$/.test(raw)) fail(400, 'bad-request')
      const since = Number(raw)
      const all = [...families.get(dev.familyId).records.values()].filter((r) => r.seq > since).sort((a, b) => a.seq - b.seq)
      const records = all.slice(0, pageSize).map((r) => ({ ...r }))
      return json({ records, next: records.length ? records.at(-1).seq : since, more: records.length === pageSize })
    }
    if (route === 'POST /api/sync') {
      const dev = auth(init)
      const records = body(init)?.records
      if (!Array.isArray(records)) fail(400, 'bad-request')
      if (records.length > MAX_PUSH) fail(413, 'limit-records')
      for (const r of records) {
        if (!r || typeof r.rid !== 'string' || !ID.test(r.rid) || typeof r.data !== 'string' || !B64URL.test(r.data)) fail(400, 'bad-request')
        if (r.data.length > MAX_DATA) fail(413, 'limit-record-size')
      }
      const fam = families.get(dev.familyId)
      const fresh = new Set(records.map((r) => r.rid).filter((rid) => !fam.records.has(rid)))
      if (fam.records.size + fresh.size > MAX_RECORDS) fail(413, 'limit-records')
      await server.onPush?.(dev.id, records)
      for (const r of records) fam.records.set(r.rid, { rid: r.rid, seq: ++fam.seq, data: r.data })
      return json({ seq: fam.seq })
    }
    if (route === 'GET /api/photos') {
      const dev = auth(init)
      const photos = [...families.get(dev.familyId).photos.values()].map(({ pid, size, uploadedAt }) => ({ pid, size, uploadedAt }))
      return json({ photos })
    }
    if (photo) {
      const dev = auth(init)
      const pid = decodeURIComponent(photo[1])
      if (!ID.test(pid)) fail(400, 'bad-request')
      const fam = families.get(dev.familyId)
      if (method === 'PUT') {
        const bytes = new Uint8Array(await new Response(init.body).arrayBuffer())
        if (bytes.byteLength > MAX_PHOTO) fail(413, 'limit-photo-size')
        if (bytes.byteLength === 0) fail(400, 'bad-request')
        if (!fam.photos.has(pid) && fam.photos.size >= MAX_PHOTOS) fail(413, 'limit-photos')
        fam.photos.set(pid, { pid, bytes, size: bytes.byteLength, uploadedAt: nowIso() })
        return new Response(null, { status: 204 })
      }
      if (method === 'GET') {
        const p = fam.photos.get(pid)
        if (!p) fail(404, 'not-found')
        return new Response(p.bytes.slice(), { headers: { 'content-type': 'application/octet-stream' } })
      }
      if (method === 'DELETE') {
        fam.photos.delete(pid)
        return new Response(null, { status: 204 })
      }
    }
    return fail(404, 'not-found')
  }

  return server
}
