// Full-screen photo viewer. Lives on <body> (like dialogs) so main-screen re-renders never touch it.
// Gestures use Pointer Events on one surface with touch-action:none; the math is in gesture.js.
import { getPhoto } from '../db.js'
import { store } from '../store.js'
import { hooks } from './render.js'
import { openEditItem, reportError } from './dialogs.js'
import { closeIcon } from './icons.js'
import { pinch, swipeIntent, stepIndex, containSize, clampPan, DOUBLE_TAP_SCALE } from './gesture.js'

const DOUBLE_TAP_MS = 300
const TAP_SLOP = 10

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

function ensureDom() {
  if (dom) return dom
  const el = document.createElement('div')
  el.id = 'viewer'
  el.hidden = true
  el.setAttribute('role', 'dialog')
  el.setAttribute('aria-modal', 'true')
  el.innerHTML = `<div class="vbar"><span class="vlabel"></span><button type="button" data-v="edit">Modifica</button><button type="button" data-v="close" aria-label="Chiudi">${closeIcon}</button></div>
    <div class="stage"><img alt="" draggable="false"></div>`
  document.body.append(el)
  dom = { el, label: el.querySelector('.vlabel'), stage: el.querySelector('.stage'), img: el.querySelector('img') }
  el.querySelector('.vbar').addEventListener('click', (e) => {
    const b = e.target.closest('[data-v]')
    if (!b) return
    if (b.dataset.v === 'close') return close()
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
  window.addEventListener('popstate', () => {
    if (expectPop) { expectPop = false; return }
    if (isOpen) { pushed = false; teardown() } // Android back
  })
  return dom
}

const draw = (x = t.x, y = t.y, s = t.s) => { dom.img.style.transform = `translate(${x}px,${y}px) scale(${s})` }
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

/** @param {string[]} itemIds items of one section, in display order @param {string} startId */
export function openViewer(itemIds, startId) {
  if (isOpen || !itemIds.length) return
  const d = ensureDom()
  ids = itemIds
  isOpen = true
  d.el.hidden = false
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
  dom.el.hidden = true
  dom.img.removeAttribute('src')
  for (const u of urls.values()) URL.revokeObjectURL(u)
  urls.clear()
  pointers.clear()
  drag = base = lastTap = null
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
  if (pointers.size === 2) {
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
  if (d.multi) { if (t.s <= 1.02) setT({ s: 1, x: 0, y: 0 }, true); return }
  const dx = e.clientX - d.sx, dy = e.clientY - d.sy
  const intent = ok ? swipeIntent(dx, dy, t.s) : null
  if (intent === 'close') return close()
  if (intent === 'next' || intent === 'prev') {
    const j = stepIndex(index, intent, ids.length)
    if (j !== null) return void show(j)
  }
  if (ok && !d.moved) return tap(e)
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
  hooks.onOpenViewer = openViewer
  hooks.onEdit = (id) => openEditItem(id)
}
