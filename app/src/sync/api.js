// Thin client for the Worker API (/api/*, same origin). One method per contract row; it adds the
// device token where the route needs it and turns every failure into an ApiError.

export class ApiError extends Error {
  /**
   * @param {number} status HTTP status; 0 = the request never got an answer (offline)
   * @param {string} code machine-readable code from the server's `{error}` (or 'offline')
   * @param {object} [extra] other fields of the error body (e.g. `devices` with family-full)
   */
  constructor(status, code, extra = {}) {
    super(code)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.extra = extra
  }
}

/**
 * @param {{ fetchFn?: typeof fetch, getToken?: () => (string|null|undefined|Promise<string|null|undefined>), base?: string }} opts
 */
export function createApi({ fetchFn = (...a) => fetch(...a), getToken = () => null, base = '' } = {}) {
  /**
   * @param {string} method
   * @param {string} path
   * @param {{ auth?: boolean, json?: any, bytes?: Uint8Array, as?: 'json'|'bytes'|'none', timeoutMs?: number }} [o]
   *   timeoutMs: give up (as 'offline') when no full answer came in time
   */
  async function call(method, path, { auth = false, json, bytes, as = 'json', timeoutMs } = {}) {
    if (timeoutMs) {
      // Raced too, not only passed to fetch: a stalled body read or a fetch ignoring the signal still ends.
      const controller = new AbortController()
      let timer
      const expired = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new ApiError(0, 'offline')) }, timeoutMs) })
      try {
        return await Promise.race([send(method, path, { auth, json, bytes, as, signal: controller.signal }), expired])
      } finally {
        clearTimeout(timer)
      }
    }
    return send(method, path, { auth, json, bytes, as })
  }

  async function send(method, path, { auth, json, bytes, as, signal }) {
    const headers = {}
    if (auth) {
      const token = await getToken()
      if (token) headers.authorization = `Bearer ${token}`
    }
    let body
    if (json !== undefined) {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(json)
    } else if (bytes) {
      headers['content-type'] = 'application/octet-stream'
      body = bytes
    }
    let res
    try {
      res = await fetchFn(base + path, { method, headers, body, cache: 'no-store', ...(signal ? { signal } : {}) })
    } catch {
      throw new ApiError(0, 'offline')
    }
    if (!res.ok) {
      let payload = {}
      try { payload = await res.json() } catch { /* not JSON (e.g. a proxy page) */ }
      const { error, ...extra } = payload ?? {}
      throw new ApiError(res.status, typeof error === 'string' ? error : `http-${res.status}`, extra)
    }
    try {
      if (as === 'bytes') return new Uint8Array(await res.arrayBuffer())
      if (as === 'none' || res.status === 204 || res.status === 202) return null
      return await res.json()
    } catch {
      throw new ApiError(0, 'offline') // the body was cut off mid-way
    }
  }
  const q = encodeURIComponent
  const post = (path, json, auth = false) => call('POST', path, { json, auth })
  const authed = { auth: true }

  return {
    /** The same client, always sending `token`: a sync run keeps its device token to the end. */
    withToken: (token) => createApi({ fetchFn, base, getToken: () => token }),
    redeem: (body) => post('/api/redeem', body),
    slot: (code) => post('/api/slot', { code }, true),
    unlockSession: (id) => call('GET', `/api/unlock/session?id=${q(id)}`),
    family: () => call('GET', '/api/family', authed),
    createInvite: () => call('POST', '/api/invites', authed),
    inviteInfo: (token) => call('GET', `/api/invites/info?t=${q(token)}`),
    join: (body) => post('/api/join', body),
    /** @param {{timeoutMs?: number}} [o] */
    removeDevice: (id, { timeoutMs } = {}) => call('DELETE', `/api/devices/${q(id)}`, { auth: true, timeoutMs }),
    recover: (body) => post('/api/recover', body),
    recoverRemoveDevice: (body) => post('/api/recover/remove-device', body),
    licenceEmail: (email) => call('POST', '/api/licence/email', { json: { email }, as: 'none' }),
    licenceRestart: (body) => post('/api/licence/restart', body),
    /** @returns {Promise<{records:{rid:string, seq:number, data:string}[], next:number, more:boolean}>} */
    pull: (since) => call('GET', `/api/sync?since=${q(String(since))}`, authed),
    /** @param {{rid:string, data:string}[]} records */
    push: (records) => post('/api/sync', { records }, true),
    /** @param {Uint8Array} bytes ciphertext */
    putPhoto: (pid, bytes) => call('PUT', `/api/photos/${q(pid)}`, { auth: true, bytes, as: 'none' }),
    /** @returns {Promise<Uint8Array>} ciphertext */
    getPhoto: (pid) => call('GET', `/api/photos/${q(pid)}`, { auth: true, as: 'bytes' }),
    listPhotos: () => call('GET', '/api/photos', authed),
    deletePhoto: (pid) => call('DELETE', `/api/photos/${q(pid)}`, { auth: true, as: 'none' }),
  }
}
