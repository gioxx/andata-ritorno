// Full-screen photo viewer. Lives on <body> (like dialogs) so main-screen re-renders never touch it.
// Gestures use Pointer Events on one surface with touch-action:none; the math is in gesture.js.
import { getPhoto } from '../db.js'
import { store, rotateAndEdit } from '../store.js'
import { hooks } from './render.js'
import { openEditItem, reportError, openModal } from './dialogs.js'
import { closeIcon, rotateIcon, chevronLeftIcon, chevronRightIcon } from './icons.js'
import { viewerAction, idleRotation } from './rotation.js'
import { pinch, swipeIntent, stepIndex, containSize, clampPan, DOUBLE_TAP_SCALE } from './gesture.js'
import { t as tr, onLangChange } from '../i18n.js'  // `t` is the pan/zoom state here

const DOUBLE_TAP_MS = 300
const TAP_SLOP = 10

const hintText = () => tr(ids.length > 1 ? 'viewer.hintMany' : 'viewer.hintOne')

let dom = null
let ids = [], index = 0
let isOpen = false
let pushed = false // we added a history entry that is still on the stack
let expectPop = false // a popstate we caused with history.back()
let token = 0 // guards async photo loads against fast navigation
const urls = new Map() // photoId -> object URL, revoked on close
let vp = { w: 1, h: 1 }, content = { w: 1, h: 1 }
let t = { s: 1, x: 0, y: 0 }
const pointers = new Map()
let drag = null, base = null, lastTap = null
let rot = idleRotation() // pending rotation (see rotation.js); nothing is saved until Salva
let angle = 0 // degrees shown, keeps growing so a turn never spins back
let busy = false // encoding + saving a rotation
let release = () => {} // gives focus back and un-inerts the page (see openModal)

function ensureDom() {
  if (dom) return dom
  const el = document.createElement('div')
  el.id = 'viewer'
  el.hidden = true
  el.setAttribute('role', 'dialog')
  el.setAttribute('aria-modal', 'true')
  el.setAttribute('aria-label', tr('viewer.title'))
  el.innerHTML = `<div class="vbar"><span class="vlabel"></span><button type="button" class="vx" data-v="close" aria-label="${tr('common.close')}">${closeIcon}</button></div>
    <div class="stage"><img alt="" draggable="false"></div>
    <button type="button" class="vnav prev" data-v="prev" aria-label="${tr('viewer.prev')}">${chevronLeftIcon}</button>
    <button type="button" class="vnav next" data-v="next" aria-label="${tr('viewer.next')}">${chevronRightIcon}</button>
    <p class="vhint"></p>
    <p class="sr" data-live="pos" aria-live="polite"></p><p class="sr" data-live="state" aria-live="polite"></p>
    <div class="vbot"><button type="button" data-v="rotate">${rotateIcon}<span>${tr('common.rotate')}</span></button><button type="button" class="n" data-v="edit">${tr('common.edit')}</button><button type="button" class="n vclose" data-v="close">${tr('common.close')}</button><button type="button" class="p" data-v="cancel">${tr('common.cancel')}</button><button type="button" class="p vclose" data-v="save">${tr('common.save')}</button></div>`
  document.body.append(el)
  dom = { el, prev: el.querySelector('.prev'), next: el.querySelector('.next'), pos: el.querySelector('[data-live="pos"]'), state: el.querySelector('[data-live="state"]'), label: el.querySelector('.vlabel'), hint: el.querySelector('.vhint'), stage: el.querySelector('.stage'), img: el.querySelector('img') }
  el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-v]')
    if (!b) return
    if (busy) return
    const v = b.dataset.v
    if (v === 'close' || v === 'rotate' || v === 'save' || v === 'cancel') return run(v)
    if (v === 'prev' || v === 'next') return step(v)
    const id = ids[index]
    close() // hide first: the edit dialog replaces the viewer
    openEditItem(id)
  })
  const s = dom.stage
  s.addEventListener('pointerdown', onDown)
  s.addEventListener('pointermove', onMove)
  s.addEventListener('pointerup', (e) => onUp(e, true))
  s.addEventListener('pointercancel', (e) => onUp(e, false))
  dom.img.addEventListener('load', () => {
    content = containSize(vp.w, vp.h, dom.img.naturalWidth, dom.img.naturalHeight)
  })
  document.addEventListener('keydown', (e) => {
    if (!isOpen) return
    if (e.key === 'Escape') { e.preventDefault(); if (!busy) run('close') }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); step(e.key === 'ArrowLeft' ? 'prev' : 'next') }
  })
  window.addEventListener('popstate', () => {
    if (expectPop) { expectPop = false; return }
    if (isOpen) { pushed = false; teardown() } // Android back
  })
  // The viewer is built once (it owns window listeners): relabel in place on a language change.
  onLangChange(() => {
    el.setAttribute('aria-label', dom.label.textContent || tr('viewer.title'))
    dom.prev.setAttribute('aria-label', tr('viewer.prev'))
    dom.next.setAttribute('aria-label', tr('viewer.next'))
    el.querySelector('.vx').setAttribute('aria-label', tr('common.close'))
    el.querySelector('[data-v="edit"]').textContent = tr('common.edit')
    el.querySelector('[data-v="rotate"] span').textContent = tr('common.rotate')
    el.querySelector('.n.vclose').textContent = tr('common.close')
    el.querySelector('[data-v="cancel"]').textContent = tr('common.cancel')
    el.querySelector('[data-v="save"]').textContent = tr('common.save')
    if (isOpen) dom.hint.textContent = hintText()
  })
  return dom
}

// While a rotation is pending the image is turned about its centre and scaled to fit the stage.
const rotTransform = () => {
  const odd = (angle / 90) % 2 !== 0
  const c = containSize(vp.w, vp.h, dom.img.naturalWidth || 1, dom.img.naturalHeight || 1)
  const k = odd ? Math.min(vp.w / c.h, vp.h / c.w) : 1
  return `rotate(${angle}deg) scale(${k})`
}
const draw = (x = t.x, y = t.y, s = t.s) => { dom.img.style.transform = rot.active ? rotTransform() : `translate(${x}px,${y}px) scale(${s})` }

function exitPending(snap = true) {
  rot = idleRotation()
  angle = 0
  dom.el.classList.remove('pending')
  dom.state.textContent = ''
  refreshNav()
  setT({ s: 1, x: 0, y: 0 }, snap)
}

/** Controls that are hidden or off in the current state must not hold focus (it would drop to <body>). */
function keepFocusInside() {
  if (!isOpen) return
  const a = document.activeElement
  const stuck = !dom.el.contains(a) || a.disabled || a.hidden || a.classList.contains(rot.active ? 'n' : 'p')
  if (!stuck) return
  const next = [dom.next, dom.prev].find((b) => !b.hidden && !b.disabled)
  ;(next ?? dom.el.querySelector('[data-v="rotate"]')).focus({ preventScroll: true })
}

/** Feed an event to the pending-rotation rules and carry out the effects. */
function run(event) {
  if (busy) return
  const r = viewerAction(rot, event)
  rot = r.state
  for (const fx of r.effects) {
    if (fx === 'resetZoom') {
      const b = dom.stage.getBoundingClientRect()
      vp = { w: b.width, h: b.height }
      t = { s: 1, x: 0, y: 0 }
      dom.el.classList.add('pending')
      dom.state.textContent = tr('viewer.pending')
      refreshNav()
    } else if (fx === 'turn') {
      angle += 90
      dom.img.classList.add('snap')
      draw()
    } else if (fx === 'discard') exitPending()
    else if (fx === 'close') close()
    else if (fx === 'commit') commitRotation()
  }
}
const allowed = (event) => viewerAction(rot, event).effects.includes(event)

async function commitRotation() {
  const id = ids[index]
  const it = store.items.find((x) => x.id === id)
  if (!it) return exitPending()
  busy = true
  dom.el.classList.add('busy')
  try {
    const oldId = it.photoId
    // Read, rotate and save inside the store's queue (serialised with other edits); a gone source
    // comes back as an error ("rotate-missing" -> rotate.missingPhoto) and the rotation stays pending.
    const failure = await rotateAndEdit(id, {}, rot.turns)
    if (failure) throw failure
    const old = urls.get(oldId)
    if (old) { URL.revokeObjectURL(old); urls.delete(oldId) }
    if (isOpen && ids[index] === id) { exitPending(false); show(index) } // no snap: the old image must not spin back; stay on the item, show the new photo
  } catch (e) { reportError(e) } // stay pending so the user can retry or cancel
  finally { busy = false; dom.el.classList.remove('busy') }
}
function setT(next, snap = false) {
  t = next
  dom.img.classList.toggle('snap', snap)
  draw()
}
const rel = (p) => {
  const r = dom.stage.getBoundingClientRect()
  return { x: p.x - (r.left + r.width / 2), y: p.y - (r.top + r.height / 2) }
}

async function show(i) {
  const d = dom
  index = i
  const my = ++token
  const it = store.items.find((x) => x.id === ids[i])
  d.label.textContent = it?.label || ''
  d.el.setAttribute('aria-label', it?.label || tr('viewer.title'))
  d.pos.textContent = tr('viewer.position', { label: it?.label || tr('common.unnamed'), n: i + 1, total: ids.length })
  refreshNav()
  setT({ s: 1, x: 0, y: 0 })
  content = vp
  d.img.removeAttribute('src')
  if (!it) return
  try {
    let url = urls.get(it.photoId)
    if (!url) {
      const blob = await getPhoto(store.db, it.photoId)
      if (!blob) return
      if (!isOpen) return
      url = urls.get(it.photoId) // a faster duplicate load (a->b->a swipe) may have won meanwhile
      if (!url) { url = URL.createObjectURL(blob); urls.set(it.photoId, url) }
    }
    if (my === token) d.img.src = url
  } catch (e) { reportError(e) }
}

/** Previous / next buttons: shown for several items, off at the ends and while a rotation is pending. */
function refreshNav() {
  const many = ids.length > 1
  for (const [b, dir] of [[dom.prev, 'prev'], [dom.next, 'next']]) {
    b.hidden = !many
    const off = rot.active || stepIndex(index, dir, ids.length) === null
    b.disabled = off
  }
  keepFocusInside()
}

/** Go to the previous / next item (buttons, arrow keys, swipes). */
function step(dir) {
  if (busy || !allowed('swipe')) return
  const j = stepIndex(index, dir, ids.length)
  if (j !== null) show(j)
}

/** @param {string[]} itemIds the swipe list in display order (selected items, or one section) @param {string} startId */
export function openViewer(itemIds, startId) {
  if (isOpen || !itemIds.length) return
  const d = ensureDom()
  ids = itemIds
  isOpen = true
  d.hint.textContent = hintText()
  d.el.hidden = false
  release = openModal(d.el)
  const r = d.stage.getBoundingClientRect()
  vp = { w: r.width, h: r.height }
  history.pushState({ arViewer: true }, '')
  pushed = true
  show(Math.max(0, ids.indexOf(startId)))
}

function teardown() {
  if (!isOpen) return
  isOpen = false
  token++
  dom.state.textContent = ''
  dom.el.hidden = true
  dom.img.removeAttribute('src')
  for (const u of urls.values()) URL.revokeObjectURL(u)
  urls.clear()
  pointers.clear()
  drag = base = lastTap = null
  rot = idleRotation()
  angle = 0
  dom.el.classList.remove('pending', 'busy')
  release()
}

/** Close from the UI; popping our history entry keeps no stray entry behind. */
function close() {
  teardown()
  if (pushed) { pushed = false; expectPop = true; history.back() }
}

function onDown(e) {
  dom.stage.setPointerCapture?.(e.pointerId)
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
  const r = dom.stage.getBoundingClientRect()
  vp = { w: r.width, h: r.height }
  if (pointers.size === 2 && !rot.active) {
    const [a, b] = [...pointers.values()]
    base = { t: { ...t }, mid: rel(mid(a, b)), dist: Math.hypot(a.x - b.x, a.y - b.y) || 1 }
    if (drag) drag.multi = true
  } else if (pointers.size === 1) {
    drag = { sx: e.clientX, sy: e.clientY, t0: { ...t }, moved: false, multi: false }
  }
}

const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })

function onMove(e) {
  if (!pointers.has(e.pointerId)) return
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
  if (rot.active) return // no pan / pinch / follow while a rotation is pending
  if (pointers.size >= 2 && base) {
    const [a, b] = [...pointers.values()]
    const ratio = (Math.hypot(a.x - b.x, a.y - b.y) || 1) / base.dist
    setT(pinch(base.t, base.mid, rel(mid(a, b)), ratio, vp, content))
    return
  }
  if (!drag) return
  const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy
  if (Math.hypot(dx, dy) > TAP_SLOP) drag.moved = true
  if (t.s > 1) setT({ s: t.s, ...clampPan(drag.t0.x + dx, drag.t0.y + dy, t.s, vp, content) })
  else if (!drag.multi) { // follow the finger a little so the swipe feels direct
    if (Math.abs(dx) > Math.abs(dy)) draw(dx, 0, 1)
    else draw(0, Math.max(0, dy), 1)
  }
}

function onUp(e, ok) {
  if (!pointers.delete(e.pointerId)) return
  if (pointers.size === 1) { // pinch -> pan: continue from the remaining finger
    const p = [...pointers.values()][0]
    drag = { sx: p.x, sy: p.y, t0: { ...t }, moved: true, multi: true }
    base = null
    return
  }
  if (pointers.size > 0 || !drag) return
  const d = drag
  drag = base = null
  if (d.multi) { if (rot.active) return; if (t.s <= 1.02) setT({ s: 1, x: 0, y: 0 }, true); return }
  const dx = e.clientX - d.sx, dy = e.clientY - d.sy
  const intent = ok ? swipeIntent(dx, dy, t.s) : null
  if (intent === 'close') return run('close')
  if ((intent === 'next' || intent === 'prev') && allowed('swipe')) {
    if (stepIndex(index, intent, ids.length) !== null) return step(intent)
  }
  if (ok && !d.moved) return allowed('zoom') ? tap(e) : undefined
  setT({ ...t }, true) // snap back from the follow offset
}

function tap(e) {
  const p = { x: e.clientX, y: e.clientY }
  const prev = lastTap
  lastTap = { time: e.timeStamp, ...p }
  if (!prev || e.timeStamp - prev.time > DOUBLE_TAP_MS || Math.hypot(p.x - prev.x, p.y - prev.y) > 30) return
  lastTap = null
  if (t.s > 1) return setT({ s: 1, x: 0, y: 0 }, true)
  const f = rel(p)
  setT(pinch(t, f, f, DOUBLE_TAP_SCALE, vp, content), true)
}

export function initViewer() {
  // A reload while the viewer was open leaves its entry as the current one: neutralise it,
  // so a later popstate is not mistaken for ours.
  if (history.state?.arViewer) history.replaceState(null, '')
  hooks.onOpenViewer = openViewer
  hooks.onEdit = (id) => openEditItem(id)
}
