// Dialogs of the family section: unlock code, devices, invite, extra seat, recovery kit, leave.
// Joining, restoring and licence recovery are another module's: it fills `familyHooks`.
import { renderSVG } from 'uqr'
import { t } from '../i18n.js'
import { esc } from './esc.js'
import { openModal, reportError } from './dialogs.js'
import { familyError } from './familyMenu.js'
import { ago, enableSyncLine } from './syncLine.js'
import { syncStatus, syncNow, subscribeSync } from '../sync/engine.js'
import { getFamily, createFamily, resumePending, leaveFamily, kitOf, inviteLink } from '../sync/family.js'

/** Rows of the locked menu that open flows living elsewhere; assigned by whoever implements them. */
export const familyHooks = { onJoinInvite() {}, onRestore() {}, onLicence() {} }

/** @type {{ db:any, api:any, onEntered:()=>Promise<void>|void, onLeft:()=>void }} */
let ctx = null
/** `onEntered`: this phone just joined a family (start syncing); `onLeft`: it no longer is in one. */
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

/** Run `fn` with the dialog's buttons disabled; errors go to its message line. */
async function busy(d, fn) {
  const btns = [...d.querySelectorAll('button')]
  btns.forEach((b) => { b.disabled = true })
  setError(d, null)
  try { return await fn() } catch (e) { setError(d, e); return undefined } finally { btns.forEach((b) => { b.disabled = false }) }
}

// ---- Code: unlock a family, or add a seat when already in one -----------------------------

export async function openCodeDialog() {
  const meta = await getFamily(ctx.db)
  const inFamily = !!meta && !meta.pending
  const d = show(`<form method="dialog"><h3>${t(inFamily ? 'family.slotCode.title' : 'family.code.title')}</h3>
    <p class="plain">${t(inFamily ? 'family.slotCode.body' : 'family.code.body')}</p>
    <input type="text" id="famCode" aria-label="${t('family.code.label')}" placeholder="AR-XXXX-XXXX-XXXX" autocomplete="off" autocapitalize="characters" spellcheck="false">
    ${inFamily ? '' : `<input type="text" id="famName" aria-label="${t('family.code.name')}" placeholder="${esc(t('family.code.nameHint'))}" maxlength="60" autocomplete="off">
    <input type="text" id="famDevice" aria-label="${t('family.code.device')}" placeholder="${esc(t('family.code.deviceHint'))}" maxlength="40" autocomplete="off">`}
    <p class="plain err" role="alert"></p>
    <button type="button" class="primary" data-go>${t(inFamily ? 'family.slotCode.go' : 'family.code.go')}</button>
    <button value="" class="cancel">${t('common.cancel')}</button></form>`)
  const val = (id) => d.querySelector(id)?.value.trim() ?? ''
  // Enter would hit the first submit button (Cancel) and drop the input: make it the primary action.
  d.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return
    e.preventDefault()
    d.querySelector('[data-go]').click()
  })
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
    // already), so no code needs typing then.
    const pending = (await getFamily(ctx.db))?.pending
    if (pending?.op === 'redeem') await resumePending(ctx.db, ctx.api)
    else if (!code) return
    else await createFamily(ctx.db, ctx.api, { code, familyName: val('#famName') || t('family.defaultName'), deviceName: val('#famDevice') || t('family.code.deviceHint') })
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
  const off = subscribeSync(draw) // the list refreshes when the sync below (or a later one) lands
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
      <p class="plain" id="famInvLeft"></p><p class="plain warn">${t('family.invite.warn')}</p>
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
