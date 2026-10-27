// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { openDb, putTab, addItems, loadAll, setSyncTracking } from '../src/db.js'
import { createApi } from '../src/sync/api.js'
import { getFamily, setFamily, createFamily, inviteLink, parseInvite } from '../src/sync/family.js'
import { initFamilyUi, openJoin, leaveBeforeWipe, familyHooks } from '../src/ui/familyDialogs.js'
import { createFakeServer } from './helpers/fakeServer.js'

const CODE = 'AR-ABCD-EFGH-JK12'
const T = '2026-02-01T00:00:00.000Z'
let server

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
  HTMLDialogElement.prototype.close = function () { if (!this.open) return; this.removeAttribute('open'); setTimeout(() => this.dispatchEvent(new Event('close')), 0) }
  globalThis.requestAnimationFrame = (f) => setTimeout(f, 0)
})
beforeEach(() => {
  document.body.innerHTML = ''
  setSyncTracking(false)
  server = createFakeServer()
})
afterEach(() => { vi.restoreAllMocks(); setSyncTracking(false) })

const until = async (fn, ms = 2000) => {
  const end = Date.now() + ms
  while (!(await fn())) {
    if (Date.now() > end) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 5))
  }
}

async function phone() {
  const db = await openDb(`ar-join-${crypto.randomUUID()}`)
  const api = createApi({ fetchFn: server.fetch, getToken: async () => (await getFamily(db))?.token })
  return { db, api }
}

async function seed(db, n) {
  await putTab(db, { id: 'tab-local', name: 'Nido', order: 0, createdAt: T, updatedAt: T })
  const ids = Array.from({ length: n }, (_, i) => `item-${i}`)
  await addItems(db,
    ids.map((id) => ({ id, tabId: 'tab-local', location: 'school', label: id, photoId: `ph-${id}`, createdAt: T, movedAt: T, updatedAt: T })),
    ids.map((id) => ({ id: `ph-${id}`, blob: new Blob([id], { type: 'image/webp' }), width: 1, height: 1 })))
}

/** An owner phone in "Famiglia Rossi" and a fresh invite to it. */
async function invite() {
  const owner = await phone()
  server.addCode(CODE)
  await createFamily(owner.db, owner.api, { code: CODE, familyName: 'Famiglia Rossi', deviceName: 'Telefono 1' })
  setSyncTracking(false) // the owner's tracking flag is process-global: the new phone starts untracked
  const { token } = await owner.api.createInvite()
  return parseInvite(inviteLink(token, await getFamily(owner.db), 'https://ar.example'))
}

const joins = () => server.requests.filter((r) => r.path === '/api/join').length
const dlg = () => document.querySelector('dialog[open]')

describe('parseInvite', () => {
  it('accepts the full link and the bare fragment, rejects malformed ones', async () => {
    const inv = await invite()
    const frag = `${inv.inviteToken}.${inv.familyId}.${inv.keyRaw}`
    expect(parseInvite(`https://ar.example/join#${frag}`)).toEqual(inv)
    expect(parseInvite(frag)).toEqual(inv)
    for (const bad of ['', 'https://ar.example/join#', `${inv.inviteToken}.${inv.familyId}`, `${frag}.extra`, `${inv.inviteToken}.x.${inv.keyRaw}`]) {
      expect(() => parseInvite(bad)).toThrow('bad-invite')
    }
  })
})

describe('join screen', () => {
  it('a phone with items gets the choice, merge by default, and the family name', async () => {
    const inv = await invite()
    const p = await phone()
    await seed(p.db, 2)
    initFamilyUi({ ...p, onEntered: vi.fn(), onLeft: vi.fn(), onExport: vi.fn() })
    await openJoin(inv)
    const d = dlg()
    expect(d.textContent).toContain('Famiglia Rossi')
    expect(d.textContent).toContain('Questo telefono ha 2 capi locali')
    expect(d.querySelector('input[value="merge"]').checked).toBe(true)
    expect(d.querySelector('input[value="replace"]').checked).toBe(false)
    expect(d.textContent).toContain('Unisci i miei capi')
    expect(d.textContent).toContain('Usa il guardaroba di famiglia')
    expect(d.querySelector('[data-go]').textContent).toBe('Entra')
  })

  it('a phone without items joins without the choice', async () => {
    const inv = await invite()
    const p = await phone()
    await putTab(p.db, { id: 'tab-empty', name: 'Nido', order: 0, createdAt: T, updatedAt: T })
    const onEntered = vi.fn()
    initFamilyUi({ ...p, onEntered, onLeft: vi.fn(), onExport: vi.fn() })
    await openJoin(inv)
    expect(dlg().querySelector('input[name="joinMode"]')).toBeNull()
    dlg().querySelector('#joinDevice').value = 'Telefono 2'
    dlg().querySelector('[data-go]').click()
    await until(() => onEntered.mock.calls.length)
    expect((await getFamily(p.db)).familyId).toBe(inv.familyId)
  })

  it('"replace" stops when the backup did not reach the user: nothing cleared, not joined', async () => {
    const inv = await invite()
    const p = await phone()
    await seed(p.db, 2)
    const onExport = vi.fn(async () => false) // share sheet closed, or the download was not found
    const onEntered = vi.fn()
    initFamilyUi({ ...p, onEntered, onLeft: vi.fn(), onExport })
    await openJoin(inv)
    dlg().querySelector('input[value="replace"]').checked = true
    dlg().querySelector('[data-go]').click()
    await until(() => onExport.mock.calls.length)
    await new Promise((r) => setTimeout(r, 30))
    expect(joins()).toBe(0)
    expect(await getFamily(p.db)).toBeNull()
    expect((await loadAll(p.db)).items).toHaveLength(2)
    expect(onEntered).not.toHaveBeenCalled()
    expect(dlg()).not.toBeNull() // the screen stays, the user can merge instead
  })

  it('"replace" after a successful backup joins and empties the local wardrobe', async () => {
    const inv = await invite()
    const p = await phone()
    await seed(p.db, 2)
    const onExport = vi.fn(async () => true)
    const onEntered = vi.fn()
    initFamilyUi({ ...p, onEntered, onLeft: vi.fn(), onExport })
    await openJoin(inv)
    dlg().querySelector('input[value="replace"]').checked = true
    dlg().querySelector('[data-go]').click()
    await until(() => onEntered.mock.calls.length)
    expect(onExport).toHaveBeenCalledOnce()
    expect((await loadAll(p.db)).items).toHaveLength(0)
    expect((await getFamily(p.db)).familyId).toBe(inv.familyId)
  })

  it('"merge" joins without a backup and keeps the items', async () => {
    const inv = await invite()
    const p = await phone()
    await seed(p.db, 2)
    const onExport = vi.fn()
    const onEntered = vi.fn()
    initFamilyUi({ ...p, onEntered, onLeft: vi.fn(), onExport })
    await openJoin(inv)
    dlg().querySelector('[data-go]').click()
    await until(() => onEntered.mock.calls.length)
    expect(onExport).not.toHaveBeenCalled()
    expect((await loadAll(p.db)).items).toHaveLength(2)
  })

  it('a phone already in a family is told to leave first and asks the server nothing', async () => {
    const inv = await invite()
    const p = await phone()
    await setFamily(p.db, { familyId: 'other-family', deviceId: 'device-01', token: 't', keyRaw: inv.keyRaw, recoverySecret: null, cursor: 0, lastSyncAt: null, licenceKind: 'family' })
    initFamilyUi({ ...p, onEntered: vi.fn(), onLeft: vi.fn(), onExport: vi.fn() })
    const before = server.requests.length
    await openJoin(inv)
    expect(dlg().textContent).toContain('Esci dalla famiglia')
    expect(dlg().querySelector('[data-go]')).toBeNull()
    expect(server.requests.length).toBe(before)
  })

  it('an expired invite says so', async () => {
    const p = await phone()
    initFamilyUi({ ...p, onEntered: vi.fn(), onLeft: vi.fn(), onExport: vi.fn() })
    const inv = await invite()
    await openJoin({ ...inv, inviteToken: 'unknown_token' })
    expect(dlg().textContent).toContain('Invito scaduto')
    expect(dlg().querySelector('[data-go]')).toBeNull()
  })
})

describe('leaveBeforeWipe', () => {
  it('none outside a family, left when the server answered, failed when offline', async () => {
    const p = await phone()
    initFamilyUi({ ...p, onEntered: vi.fn(), onLeft: vi.fn(), onExport: vi.fn() })
    expect(await leaveBeforeWipe()).toBe('none')
    server.addCode(CODE)
    await createFamily(p.db, p.api, { code: CODE, familyName: 'Famiglia Rossi', deviceName: 'Telefono 1' })
    server.offline = true
    expect(await leaveBeforeWipe()).toBe('failed')
    server.offline = false
    expect(await leaveBeforeWipe()).toBe('left')
    expect(await getFamily(p.db)).toBeNull()
  })
})

describe('leaveBeforeWipe edge cases', () => {
  it('a hanging connection times out as failed, so the wipe can go on', async () => {
    const p = await phone()
    initFamilyUi({ ...p, onEntered: vi.fn(), onLeft: vi.fn(), onExport: vi.fn() })
    server.addCode(CODE)
    await createFamily(p.db, p.api, { code: CODE, familyName: 'Famiglia Rossi', deviceName: 'Telefono 1' })
    server.beforeHandle = () => new Promise(() => {}) // never answers
    expect(await leaveBeforeWipe({ timeoutMs: 30 })).toBe('failed')
  })

  it('a redeem still pending is reported as failed (the server may know this phone)', async () => {
    const p = await phone()
    initFamilyUi({ ...p, onEntered: vi.fn(), onLeft: vi.fn(), onExport: vi.fn() })
    await setFamily(p.db, { familyId: 'family-1234', deviceId: 'device-01', token: null, keyRaw: 'A'.repeat(43), recoverySecret: 's', cursor: 0, lastSyncAt: null, licenceKind: 'family', pending: { op: 'redeem', body: {} } })
    expect(await leaveBeforeWipe()).toBe('failed')
  })
})

describe('licence link from the URL', () => {
  it('a malformed token never reaches the destructive confirmation: step 1 with the bad-link message', async () => {
    const p = await phone()
    initFamilyUi({ ...p, onEntered: vi.fn(), onLeft: vi.fn(), onExport: vi.fn() })
    await familyHooks.onLicence('not a token!')
    expect(dlg().querySelector('#famLicEmail')).not.toBeNull()
    expect(dlg().textContent).toContain('Link non valido')
    expect(dlg().textContent).not.toContain('Inizia una nuova famiglia con la tua licenza')
  })

  it('a well-formed token opens step 2', async () => {
    const p = await phone()
    initFamilyUi({ ...p, onEntered: vi.fn(), onLeft: vi.fn(), onExport: vi.fn() })
    await familyHooks.onLicence('A'.repeat(43))
    expect(dlg().textContent).toContain('Inizia una nuova famiglia con la tua licenza')
  })
})
