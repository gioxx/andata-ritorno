// @vitest-environment jsdom
import { it, expect, afterEach } from 'vitest'
import { openDb, setSyncTracking } from '../src/db.js'
import { createApi } from '../src/sync/api.js'
import { initSync, syncNow } from '../src/sync/engine.js'
import { getFamily, createFamily } from '../src/sync/family.js'
import { createFakeServer } from './helpers/fakeServer.js'

afterEach(() => setSyncTracking(false))

it('the app syncs again as soon as the connection comes back', async () => {
  const server = createFakeServer()
  const db = await openDb(`ar-online-${crypto.randomUUID()}`)
  const api = createApi({ fetchFn: server.fetch, getToken: async () => (await getFamily(db))?.token })
  server.addCode('AR-ABCD-EFGH-JK12')
  await createFamily(db, api, { code: 'AR-ABCD-EFGH-JK12', familyName: 'Famiglia Rossi', deviceName: 'Telefono 1' })
  await initSync({ db, api, onApplied: () => {}, exclusive: (fn) => fn() })
  server.offline = true
  await syncNow('start')
  server.offline = false
  const before = server.requests.length
  window.dispatchEvent(new Event('online'))
  await syncNow('menu') // joins the run the event started (single-flight), or starts one
  const runs = server.requests.slice(before).filter((r) => r.path === '/api/family').length
  expect(runs).toBe(2) // the online run plus the one queued behind it
})
