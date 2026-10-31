// Dialogs of the family section: unlock code, devices, invite, extra seat, recovery kit, leave,
// and the ways in without a code: join by invite, restore with the kit, licence recovery.
import { renderSVG } from 'uqr'
import { t } from '../i18n.js'
import { esc } from './esc.js'
import { openModal, reportError } from './dialogs.js'
import { familyError } from './familyMenu.js'
import { ago, enableSyncLine } from './syncLine.js'
import { scanButton, scanQr } from './scan.js'
import { syncStatus, syncNow, subscribeSync, isProgressOnly } from '../sync/engine.js'
import { loadAll } from '../db.js'
import { load, runExclusive, store, addTab } from '../store.js'
import { parseLicenceLink } from '../routes.js'
import {
  getFamily, createFamily, resumePending, leaveFamily, kitOf, inviteLink, parseInvite, parseKit,
  inviteFamilyName, joinFamily, recoverFamily, restartFromLicence,
} from '../sync/family.js'

/**
 * Entry points used by the menu, the welcome screen, the import flow and the path-routed pages.
 * onJoinInvite(link?): a link opens the join screen (a bad one the paste box); none, the paste box.
 * onRestore({kit}?): the restore screen, optionally prefilled. onLicence(linkToken?): step 1 or 2.
 */
export const familyHooks = {
  onJoinInvite: (link) => openHaveInvite(link),
  onRestore: (o) => openRestore(o),
  onLicence: (linkToken) => openLicenceLink(linkToken),
  onHaveCode: () => openCodeDialog({ fromWelcome: true }),
}

/** @type {{ db:any, api:any, onEntered:()=>Promise<void>|void, onLeft:()=>void, onExport:()=>Promise<boolean> }} */
let ctx = null
/**
 * `onEntered`: this phone just joined a family (start syncing); `onLeft`: it no longer is in one;
 * `onExport`: the menu's backup export, true only once the file surely reached the user.
 */
export const initFamilyUi = (c) => { ctx = c }

function show(html) {
  const d = document.createElement('dialog')
  d.innerHTML = html
  document.body.append(d)
  d.addEventListener('close', () => d.remove(), { once: true })
  return d
}

/** White-backed QR as inline SVG, sized by CSS. */
export const qrSvg = (text) => renderSVG(text, { ecc: 'M', border: 2 })

const setError = (d, e) => { d.querySelector('.err').textContent = e ? familyError(e) : '' }

/** Enter in a field runs the primary action (the first submit button would be Cancel). */
function enterGoes(d) {
  d.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return
    e.preventDefault()
    d.querySelector('[data-go]')?.click()
  })
}

/**
 * An earlier join or recovery, finished on the way, put this phone in a family: start syncing it,
 * then let the dialog say so (the error goes on).
 */
async function enteredEarlier(e) {
  if (e?.code === 'already-in-family') {
    await load(ctx.db)
    Promise.resolve(ctx.onEntered()).catch(reportError)
  }
  throw e
}

/** Fill `input` from a scanned QR code when the dialog has a scan button. */
function wireScan(d, input) {
  d.querySelector('[data-scan]')?.addEventListener('click', async () => {
    const text = await scanQr().catch(() => null)
    if (text) { input.value = text; input.dispatchEvent(new Event('input')) }
  })
}

/**
 * Joining, restoring and licence recovery start a membership: refused while this phone is in a
 * family (it must leave first) or still waiting for a code's answer (that answer would be lost).
 * A join or recovery still waiting for its answer does not block joining or restoring: trying
 * again replays it (same invite or kit) or starts over.
 * @param {{retry?: boolean}} [o] retry: this dialog joins or restores
 * @returns {Promise<boolean>} true when refused (a dialog says why)
 */
async function refusedByMembership(title, { retry = false } = {}) {
  const meta = await getFamily(ctx.db)
  if (!meta) return false
  if (retry && (meta.pending?.op === 'join' || meta.pending?.op === 'recover')) return false
  const d = show(`<form method="dialog"><h3>${title}</h3>
    <p class="plain">${t(meta.pending ? 'family.pendingFirst' : 'family.leaveFirst')}</p>
    <button value="" class="cancel">${t('common.close')}</button></form>`)
  openModal(d)
  return true
}

/** Run `fn` with the dialog's buttons disabled; errors go to its message line. */
async function busy(d, fn) {
  const btns = [...d.querySelectorAll('button')]
  btns.forEach((b) => { b.disabled = true })
  setError(d, null)
  try { return await fn() } catch (e) { setError(d, e); return undefined } finally { btns.forEach((b) => { b.disabled = false }) }
}

// ---- Code: unlock a family, or add a seat when already in one -----------------------------

/**
 * @param {{fromWelcome?: boolean, buyLink?: string|null}} [o] fromWelcome: a phone with no tabs yet
 *   gets a default one once the family exists, before its first upload, so the family starts with it
 *   and the app opens. buyLink: in a family, the payment link for an extra seat (payments on).
 */
export async function openCodeDialog({ fromWelcome = false, buyLink = null } = {}) {
  const meta = await getFamily(ctx.db)
  const inFamily = !!meta && !meta.pending
  const buy = inFamily && buyLink
  const d = show(`<form method="dialog"><h3>${t(inFamily ? 'family.slot' : 'family.code.title')}</h3>
    <p class="plain">${t(inFamily ? (buy ? 'family.slotCode.bodyBuy' : 'family.slotCode.body') : 'family.code.body')}</p>
    ${buy ? `<button type="button" data-buy>${t('family.slotCode.buy', { price: t('family.slotPrice') })}</button>` : ''}
    <input type="text" id="famCode" aria-label="${t('family.code.label')}" placeholder="AR-XXXX-XXXX-XXXX" autocomplete="off" autocapitalize="characters" spellcheck="false">
    ${inFamily ? '' : `<input type="text" id="famName" aria-label="${t('family.code.name')}" placeholder="${esc(t('family.code.nameHint'))}" maxlength="60" autocomplete="off">
    <input type="text" id="famDevice" aria-label="${t('family.code.device')}" placeholder="${esc(t('family.code.deviceHint'))}" maxlength="40" autocomplete="off">`}
    <p class="plain"><a href="/privacy.html" target="_blank" rel="noopener">${t('privacy.link')}</a></p>
    <p class="plain err" role="alert"></p>
    <button type="button" class="primary" data-go>${t(inFamily ? 'family.slotCode.go' : 'family.code.go')}</button>
    <button value="" class="cancel">${t('common.cancel')}</button></form>`)
  const val = (id) => d.querySelector(id)?.value.trim() ?? ''
  enterGoes(d)
  d.querySelector('[data-buy]')?.addEventListener('click', () => window.open(buyLink, '_blank', 'noopener'))
  d.querySelector('[data-go]').addEventListener('click', () => busy(d, async () => {
    const code = val('#famCode')
    if (inFamily) {
      if (!code) return
      const { deviceLimit } = await ctx.api.slot(code)
      d.querySelector('.err').textContent = t('family.slotCode.done', { n: deviceLimit })
      syncNow('menu') // refreshes the devices count
      return
    }
    // An earlier attempt whose answer was lost is finished, not redone (the code may be spent
    // already), so no code needs typing then. The engine may have finished it meanwhile: done.
    const stored = await getFamily(ctx.db)
    if (stored && !stored.pending) { /* finished in the background */ }
    else if (stored?.pending?.op === 'redeem') await resumePending(ctx.db, ctx.api)
    else if (!code) return
    else await createFamily(ctx.db, ctx.api, { code, familyName: val('#famName') || t('family.defaultName'), deviceName: val('#famDevice') || t('family.code.deviceHint') }).catch(enteredEarlier)
    // Tracking is on now: the new tab is queued with everything else for the first sync.
    if (fromWelcome && store.db === ctx.db && !(await loadAll(ctx.db)).tabs.length) await addTab(t('sync.defaultTab'))
    // The family exists now: show the kit first, then start syncing; failures here have no form to show them.
    d.close()
    openKit({ first: true }).catch(reportError)
    Promise.resolve(ctx.onEntered()).catch(reportError)
  }))
  openModal(d)
}

// ---- Devices -----------------------------------------------------------------------------

const devicesBody = () => {
  const fam = syncStatus.family
  if (!fam) {
    if (syncStatus.state === 'syncing') return `<p class="plain">${t('sync.syncing')}</p>`
    return `<p class="plain">${familyError(syncStatus.errorCode ?? 'offline')}</p><button type="button" data-retry>${t('family.retry')}</button>`
  }
  const now = new Date()
  return `<ul class="famDevices">${fam.devices.map((v) => `<li><span class="txt"><b>${esc(v.name || t('family.devices.unnamed'))}</b>${v.isThis ? ` <span class="tag">${t('family.devices.this')}</span>` : ''}<small>${esc(t('family.devices.lastSeen', { ago: ago(v.lastSeenAt, now) }))}</small></span>${
    v.isThis ? '' : `<button type="button" class="danger" data-remove="${esc(v.id)}">${t('family.devices.remove')}</button>`}</li>`).join('')}</ul>`
}

export function openDevices() {
  const d = show(`<form method="dialog"><h3>${t('family.devices.title')}</h3><div id="famDevBody"></div>
    <p class="plain err" role="alert"></p><button value="" class="cancel">${t('common.close')}</button></form>`)
  const body = d.querySelector('#famDevBody')
  const draw = () => { body.innerHTML = devicesBody() }
  draw()
  // The list refreshes when the sync below (or a later one) lands; progress ticks change nothing here.
  const off = subscribeSync((_s, patch) => { if (!isProgressOnly(patch)) draw() })
  d.addEventListener('close', off, { once: true })
  syncNow('menu')
  body.addEventListener('click', (e) => {
    if (e.target.closest('[data-retry]')) { syncNow('menu'); return }
    const id = e.target.closest('[data-remove]')?.dataset.remove
    const dev = syncStatus.family?.devices.find((v) => v.id === id)
    if (dev) confirmRemove(d, dev)
  })
  openModal(d)
}

function confirmRemove(parent, dev) {
  const c = show(`<form method="dialog"><h3>${t('family.devices.removeTitle', { name: esc(dev.name || t('family.devices.unnamed')) })}</h3>
    <p class="plain">${t('family.devices.removeBody')}</p><p class="plain err" role="alert"></p>
    <button type="button" class="danger" data-go>${t('family.devices.removeGo')}</button>
    <button value="" class="cancel">${t('common.cancel')}</button></form>`)
  c.querySelector('[data-go]').addEventListener('click', () => busy(c, async () => {
    await ctx.api.removeDevice(dev.id)
    c.close()
    await syncNow('menu')
  }))
  openModal(c)
}

// ---- Invite ------------------------------------------------------------------------------

const mmss = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }

export async function openInvite() {
  const meta = await getFamily(ctx.db)
  const d = show(`<form method="dialog"><h3>${t('family.invite.title')}</h3>
    <div id="famInvBody"><p class="plain">${t('sync.syncing')}</p></div>
    <p class="plain err" role="alert"></p><button value="" class="cancel">${t('common.close')}</button></form>`)
  const body = d.querySelector('#famInvBody')
  let timer = null
  let link = ''
  d.addEventListener('close', () => clearInterval(timer), { once: true })

  async function issue() {
    clearInterval(timer)
    setError(d, null)
    let inv
    try {
      inv = await ctx.api.createInvite()
      link = inviteLink(inv.token, meta)
    } catch (e) { body.innerHTML = ''; setError(d, e); return }
    body.innerHTML = `<p class="plain">${t('family.invite.body')}</p><div class="qr">${qrSvg(link)}</div>
      <p class="plain">${t('family.invite.seat', { n: inv.used + 1, m: inv.limit })}</p><p class="plain" id="famInvLeft"></p><p class="plain warn">${t('family.invite.warn')}</p>
      <button type="button" class="primary" data-share>${t('family.invite.share')}</button>`
    const left = body.querySelector('#famInvLeft')
    const share = body.querySelector('[data-share]')
    const tick = () => {
      const ms = new Date(inv.expiresAt).getTime() - Date.now()
      if (ms > 0) { left.textContent = t('family.invite.expires', { time: mmss(ms) }); return }
      clearInterval(timer)
      body.querySelector('.qr').remove()
      left.textContent = t('family.invite.expired')
      link = ''
      share.removeAttribute('data-share')
      share.setAttribute('data-renew', '')
      share.textContent = t('family.invite.renew')
    }
    tick()
    timer = setInterval(tick, 1000)
  }
  body.addEventListener('click', async (e) => {
    if (e.target.closest('[data-renew]')) return issue()
    if (!e.target.closest('[data-share]') || !link) return
    setError(d, null)
    try {
      if (navigator.share) await navigator.share({ url: link })
      else { await navigator.clipboard.writeText(link); d.querySelector('.err').textContent = t('family.invite.copied') }
    } catch (err) {
      if (err?.name !== 'AbortError') d.querySelector('.err').textContent = t('family.copyFailed')
    }
  })
  openModal(d)
  issue().catch(reportError)
}

// ---- Recovery kit ------------------------------------------------------------------------

/** @param {{first?: boolean}} [o] first: shown once right after the family was created */
export async function openKit({ first = false } = {}) {
  const meta = await getFamily(ctx.db)
  let kit = null
  try { kit = kitOf(meta) } catch { /* an invited phone gets the secret with a later sync */ }
  const d = show(`<form method="dialog"><h3>${t('family.kit.title')}</h3>
    <p class="plain">${t('family.kit.body')}</p>${kit ? `<div class="qr">${qrSvg(kit)}</div>
    <textarea readonly rows="4" class="kitText" aria-label="${t('family.kit.title')}">${esc(kit)}</textarea>
    <p class="plain warn">${t('family.kit.warn')}</p>
    <div class="wipe-actions"><button type="button" data-copy>${t('family.kit.copy')}</button>
    <button type="button" data-save>${t('family.kit.save')}</button></div>` : `<p class="plain warn">${t('family.kit.missing')}</p>`}
    <p class="plain err" role="alert"></p><button value="" class="cancel">${t(first ? 'common.ok' : 'common.close')}</button></form>`)
  d.addEventListener('click', async (e) => {
    if (e.target.closest('[data-copy]')) {
      try { await navigator.clipboard.writeText(kit); d.querySelector('.err').textContent = t('family.kit.copied') } catch { d.querySelector('.err').textContent = t('family.copyFailed') }
    } else if (e.target.closest('[data-save]')) {
      const url = URL.createObjectURL(new Blob([`${kit}\n`], { type: 'text/plain' }))
      const a = Object.assign(document.createElement('a'), { href: url, download: t('family.kit.file') })
      document.body.append(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 10000)
    }
  })
  openModal(d)
}

// ---- Leave -------------------------------------------------------------------------------

export function openLeave() {
  const d = show(`<form method="dialog"><h3>${t('family.leave.title')}</h3>
    <p class="plain">${t('family.leave.body')}</p><p class="plain err" role="alert"></p>
    <button type="button" class="danger" data-go>${t('family.leave.go')}</button>
    <button value="" class="cancel">${t('common.cancel')}</button></form>`)
  d.querySelector('[data-go]').addEventListener('click', () => busy(d, async () => {
    await leaveFamily(ctx.db, ctx.api)
    enableSyncLine(false) // the line and html.in-family go away with the family
    d.close()
    ctx.onLeft()
  }))
  openModal(d)
}

// ---- Join by invite ----------------------------------------------------------------------

/** Paste box for an invite link ("Ho un invito"), prefilled with a link that did not parse. */
export async function openHaveInvite(link = '') {
  if (link) {
    let invite = null
    try { invite = parseInvite(link) } catch { /* shown below with its error */ }
    if (invite) return openJoin(invite)
  }
  if (await refusedByMembership(t('family.haveInvite'), { retry: true })) return
  const d = show(`<form method="dialog"><h3>${t('family.haveInvite')}</h3>
    <p class="plain">${t('family.join.pasteBody')}</p>
    <textarea rows="3" class="kitText" id="famInvLink" aria-label="${t('family.join.pasteLabel')}" spellcheck="false" autocapitalize="off">${esc(link)}</textarea>
    ${scanButton()}
    <p class="plain err" role="alert">${link ? t('family.join.badInvite') : ''}</p>
    <button type="button" class="primary" data-go>${t('family.join.next')}</button>
    <button value="" class="cancel">${t('common.cancel')}</button></form>`)
  const input = d.querySelector('#famInvLink')
  wireScan(d, input)
  d.querySelector('[data-go]').addEventListener('click', () => {
    let invite
    try { invite = parseInvite(input.value) } catch { d.querySelector('.err').textContent = t('family.join.badInvite'); return }
    d.close()
    openJoin(invite).catch(reportError)
  })
  openModal(d)
}

/**
 * Join screen: the family name from the invite, this phone's name, and, when the phone has items,
 * merge them (default) or replace them with the family's after a backup that surely reached the user.
 * @param {{inviteToken:string, familyId:string, keyRaw:string}} invite
 */
export async function openJoin(invite) {
  if (await refusedByMembership(t('family.join.title'), { retry: true })) return
  const d = show(`<form method="dialog"><h3>${t('family.join.title')}</h3>
    <div id="famJoinBody"><p class="plain">${t('sync.syncing')}</p></div>
    <p class="plain err" role="alert"></p><button value="" class="cancel">${t('common.cancel')}</button></form>`)
  openModal(d)
  const body = d.querySelector('#famJoinBody')
  let name = null
  let count = 0
  try {
    const info = await ctx.api.inviteInfo(invite.inviteToken)
    name = await inviteFamilyName(invite, info.familyNameEnc)
    // Wrong key in the link: joining would only bring unreadable data.
    if (name === null) throw new Error('bad-invite')
    if (info.used >= info.limit) throw Object.assign(new Error('family-full'), { code: 'family-full' })
    count = (await loadAll(ctx.db)).items.length
  } catch (e) {
    body.innerHTML = ''
    d.querySelector('.err').textContent = e?.message === 'bad-invite' ? t('family.join.badInvite') : familyError(e)
    return
  }
  body.innerHTML = `<p class="plain">${t('family.join.body', { name: `<b>${esc(name)}</b>` })}</p>
    <input type="text" id="joinDevice" aria-label="${t('family.code.device')}" placeholder="${esc(t('family.code.deviceHint'))}" maxlength="40" autocomplete="off">
    ${count ? `<p class="plain">${t('family.join.count', { n: count })}</p>
    <label class="choice"><input type="radio" name="joinMode" value="merge" checked> ${t('family.join.merge')}</label>
    <label class="choice"><input type="radio" name="joinMode" value="replace"> ${t('family.join.replace')}</label>
    <p class="plain note">${t('family.join.replaceNote')}</p>` : ''}
    <button type="button" class="primary" data-go>${t('family.join.go')}</button>`
  enterGoes(d)
  d.querySelector('[data-go]').addEventListener('click', () => busy(d, async () => {
    const mode = d.querySelector('input[name="joinMode"]:checked')?.value ?? 'merge'
    // Replacing removes this phone's items: only once a backup of them surely exists.
    if (mode === 'replace' && !(await ctx.onExport())) { d.querySelector('.err').textContent = t('family.join.noBackup'); return }
    const deviceName = d.querySelector('#joinDevice').value.trim() || t('family.code.deviceHint')
    // Alone in the mutation queue: an edit landing between clearing and reloading would be lost.
    await runExclusive(async () => {
      await joinFamily(ctx.db, ctx.api, { ...invite, deviceName, mode })
      if (mode === 'replace') await load(ctx.db)
    }).catch(enteredEarlier)
    d.close()
    Promise.resolve(ctx.onEntered()).catch(reportError)
  }))
}

// ---- Restore with the recovery kit -------------------------------------------------------

/** @param {{kit?: string}} [o] kit: prefilled (e.g. found in an imported backup) */
export async function openRestore({ kit = '' } = {}) {
  if (await refusedByMembership(t('family.restore'), { retry: true })) return
  const d = show(`<form method="dialog"><h3>${t('family.restore')}</h3>
    <p class="plain">${t('family.restore.body')}</p>
    <textarea rows="4" class="kitText" id="famKitIn" aria-label="${t('family.kit.title')}" spellcheck="false" autocapitalize="off">${esc(kit)}</textarea>
    ${scanButton()}
    <input type="text" id="famRestDevice" aria-label="${t('family.code.device')}" placeholder="${esc(t('family.code.deviceHint'))}" maxlength="40" autocomplete="off">
    <div id="famRestFull"></div>
    <p class="plain err" role="alert"></p>
    <button type="button" class="primary" data-go>${t('family.restore.go')}</button>
    <button value="" class="cancel">${t('common.cancel')}</button></form>`)
  const input = d.querySelector('#famKitIn')
  const full = d.querySelector('#famRestFull')
  wireScan(d, input)
  enterGoes(d)
  const readKit = () => { try { return parseKit(input.value) } catch { throw Object.assign(new Error('bad-kit'), { code: 'bad-kit' }) } }
  d.querySelector('[data-go]').addEventListener('click', () => busy(d, async () => {
    const parsed = readKit()
    const deviceName = d.querySelector('#famRestDevice').value.trim() || t('family.code.deviceHint')
    full.innerHTML = ''
    try {
      await runExclusive(() => recoverFamily(ctx.db, ctx.api, parsed, deviceName)).catch(enteredEarlier)
    } catch (e) {
      if (e?.code !== 'family-full' || !Array.isArray(e.extra?.devices)) throw e
      // Full: the kit may free a seat, so the user picks a phone that is gone for good.
      full.innerHTML = `<p class="plain">${t('family.restore.full')}</p><ul class="famDevices">${e.extra.devices.map((v) => `<li><span class="txt"><b>${esc(v.name || t('family.devices.unnamed'))}</b><small>${esc(t('family.devices.lastSeen', { ago: ago(v.lastSeenAt, new Date()) }))}</small></span>
        <button type="button" class="danger" data-free="${esc(v.id)}">${t('family.devices.remove')}</button></li>`).join('')}</ul>`
      return
    }
    d.close()
    Promise.resolve(ctx.onEntered()).catch(reportError)
  }))
  full.addEventListener('click', (e) => {
    const id = e.target.closest('[data-free]')?.dataset.free
    if (!id) return
    busy(d, async () => {
      const { familyId, recoverySecret } = readKit()
      await ctx.api.recoverRemoveDevice({ familyId, recoverySecret, deviceId: id })
      full.innerHTML = `<p class="plain">${t('family.restore.freed')}</p>`
    })
  })
  openModal(d)
}

// ---- Licence recovery --------------------------------------------------------------------

/**
 * A token from the URL: only a well-formed one may lead to the destructive confirmation; a bad
 * one lands on step 1 saying so.
 */
function openLicenceLink(linkToken) {
  if (!linkToken) return openLicence()
  let token
  try { token = parseLicenceLink(linkToken) } catch { return openLicence({ error: t('family.licence.badLink') }) }
  return openLicenceRestart(token)
}

/**
 * Step 1: ask for the email used to pay; the link it gets can also be pasted here (iOS).
 * @param {{error?: string}} [o] a message to show from the start
 */
export async function openLicence({ error = '' } = {}) {
  if (await refusedByMembership(t('family.licence'))) return
  const d = show(`<form method="dialog"><h3>${t('family.licence')}</h3>
    <p class="plain">${t('family.licence.body')}</p>
    <input type="email" id="famLicEmail" aria-label="${t('family.licence.email')}" placeholder="${esc(t('family.licence.emailHint'))}" autocomplete="email" autocapitalize="off" spellcheck="false">
    <button type="button" class="primary" data-go>${t('family.licence.send')}</button>
    <p class="plain">${t('family.licence.pasteBody')}</p>
    <input type="text" id="famLicLink" aria-label="${t('family.licence.pasteLabel')}" autocomplete="off" autocapitalize="off" spellcheck="false">
    <button type="button" data-link>${t('family.join.next')}</button>
    <p class="plain err" role="alert">${esc(error)}</p>
    <button value="" class="cancel">${t('common.close')}</button></form>`)
  const email = d.querySelector('#famLicEmail')
  const link = d.querySelector('#famLicLink')
  d.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return
    e.preventDefault()
    d.querySelector(e.target === link ? '[data-link]' : '[data-go]').click()
  })
  d.querySelector('[data-go]').addEventListener('click', () => busy(d, async () => {
    const v = email.value.trim()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) { d.querySelector('.err').textContent = t('family.licence.badEmail'); return }
    await ctx.api.licenceEmail(v)
    // The answer is the same whether or not the email matched a licence.
    d.querySelector('.err').textContent = t('family.licence.sent')
  }))
  d.querySelector('[data-link]').addEventListener('click', () => {
    let token
    try { token = parseLicenceLink(link.value) } catch { d.querySelector('.err').textContent = t('family.licence.badLink'); return }
    d.close()
    openLicenceRestart(token).catch(reportError)
  })
  openModal(d)
}

/** Step 2 (the emailed link): a fresh family on the same licence, after an explicit confirmation. */
export async function openLicenceRestart(linkToken) {
  const pending = (await getFamily(ctx.db))?.pending
  if (pending?.op !== 'restart' && (await refusedByMembership(t('family.licence')))) return
  const d = show(`<form method="dialog"><h3>${t('family.licence')}</h3>
    <p class="plain warn">${t('family.licence.confirm')}</p>
    ${pending ? '' : `<input type="text" id="famName" aria-label="${t('family.code.name')}" placeholder="${esc(t('family.code.nameHint'))}" maxlength="60" autocomplete="off">
    <input type="text" id="famDevice" aria-label="${t('family.code.device')}" placeholder="${esc(t('family.code.deviceHint'))}" maxlength="40" autocomplete="off">`}
    <p class="plain err" role="alert"></p>
    <button type="button" class="danger" data-go>${t('family.licence.go')}</button>
    <button value="" class="cancel">${t('common.cancel')}</button></form>`)
  const val = (id) => d.querySelector(id)?.value.trim() ?? ''
  enterGoes(d)
  d.querySelector('[data-go]').addEventListener('click', () => busy(d, async () => {
    // A restart whose answer was lost is finished with the same body, not started again; one the
    // engine finished meanwhile is done.
    const stored = await getFamily(ctx.db)
    if (stored && !stored.pending) { /* finished in the background */ }
    else if (stored?.pending?.op === 'restart') await resumePending(ctx.db, ctx.api)
    else await restartFromLicence(ctx.db, ctx.api, { linkToken, familyName: val('#famName') || t('family.defaultName'), deviceName: val('#famDevice') || t('family.code.deviceHint') }).catch(enteredEarlier)
    // A new family means a new kit: show it first, as after a code.
    d.close()
    openKit({ first: true }).catch(reportError)
    Promise.resolve(ctx.onEntered()).catch(reportError)
  }))
  openModal(d)
}

// ---- Before erasing everything -----------------------------------------------------------

/**
 * Leave the family before the data is wiped, so the phone does not linger in "Dispositivi".
 * Best effort: offline or no answer within `timeoutMs`, the wipe goes on and the user is told to
 * remove it from another phone. So is a redeem/restart still pending: the server may already have
 * added this phone, and it has no token to remove itself with.
 * @param {{timeoutMs?: number}} [o]
 * @returns {Promise<'none'|'left'|'failed'>}
 */
export async function leaveBeforeWipe({ timeoutMs = 10000 } = {}) {
  const meta = ctx && (await getFamily(ctx.db))
  if (!meta) return 'none'
  if (meta.pending) return 'failed'
  try {
    await leaveFamily(ctx.db, ctx.api, { timeoutMs })
    return 'left'
  } catch {
    return 'failed'
  }
}
