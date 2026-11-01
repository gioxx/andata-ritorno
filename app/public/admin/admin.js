// Owner dashboard: renders /api/admin/stats (aggregate numbers only; behind Cloudflare Access) as
// KPIs with the change against the previous period, interactive SVG charts with a table view each,
// and the switch that closes new registrations in an emergency. Plain DOM, no libraries (CSP: self).
const $ = (sel, root = document) => root.querySelector(sel)
const out = $('#out')
const at = $('#at')
const tip = $('#tip')
const nf = new Intl.NumberFormat('it-IT')
const eur = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' })
const n = (v) => nf.format(Number(v) || 0)
const gb = (b) => `${(Number(b) / 1e9).toLocaleString('it-IT', { maximumFractionDigits: 2 })} GB`
const SVGNS = 'http://www.w3.org/2000/svg'
const KIND = { family: 'Famiglia', slot: 'Posto in più' }
const SOURCE = { stripe: 'Stripe', manual: 'Manuale' }

const state = { days: 30, kind: 'all', tables: false, data: null, usage: null }

// ---------- small DOM helpers (labels always through textContent) ----------
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v
    else if (k === 'text') e.textContent = v
    else e.setAttribute(k, v)
  }
  for (const k of kids) if (k) e.append(k)
  return e
}
function svg(tag, attrs = {}) {
  const e = document.createElementNS(SVGNS, tag)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v)
  return e
}
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()

// ---------- tooltip: value first, then label ----------
function showTip(evt, title, rows) {
  tip.replaceChildren(el('div', { class: 't', text: title }))
  for (const r of rows) {
    const key = el('i'); key.style.background = r.color
    tip.append(el('div', { class: 'r' }, key, el('b', { text: r.value }), el('span', { text: r.label })))
  }
  tip.hidden = false
  const x = Math.min(innerWidth - tip.offsetWidth - 12, (evt.clientX ?? 0) + 14)
  const y = Math.max(8, (evt.clientY ?? 0) - tip.offsetHeight - 12)
  tip.style.left = `${x}px`
  tip.style.top = `${y}px`
}
const hideTip = () => { tip.hidden = true }

// ---------- buckets: fill the gaps so every day (or month) of the range has a value ----------
function buckets(days, by) {
  const list = []
  const now = new Date()
  if (by === 'month') {
    for (let i = 11; i >= 0; i--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))
      list.push(d.toISOString().slice(0, 7))
    }
  } else {
    for (let i = days - 1; i >= 0; i--) list.push(new Date(now.getTime() - i * 864e5).toISOString().slice(0, 10))
  }
  return list
}
const toMap = (rows, key = 'n') => new Map(rows.map((r) => [r.b, Number(r[key]) || 0]))
const shortLabel = (b, by) => {
  if (by === 'month') return new Date(`${b}-01T12:00:00Z`).toLocaleDateString('it-IT', { month: 'short' })
  return new Date(`${b}T12:00:00Z`).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })
}
const longLabel = (b, by) => {
  if (by === 'month') return new Date(`${b}-01T12:00:00Z`).toLocaleDateString('it-IT', { month: 'long', year: 'numeric' })
  return new Date(`${b}T12:00:00Z`).toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'long' })
}
const niceMax = (v) => {
  if (v <= 4) return 4
  const p = 10 ** Math.floor(Math.log10(v))
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p
  return v
}

// ---------- charts ----------
// Charts are drawn at roughly their on-screen width, so 11px labels stay 11px in narrow cards.
let W = 640
const H = 220, PAD = { l: 34, r: 16, t: 14, b: 26 }
const WIDTH = { w4: 380, w6: 580, w8: 780 }

function axes(g, max, labels, by) {
  const ih = H - PAD.t - PAD.b
  for (let i = 0; i <= 4; i++) {
    const y = PAD.t + ih - (ih * i) / 4
    if (i > 0) g.append(svg('line', { class: 'grid', x1: PAD.l, x2: W - PAD.r, y1: y, y2: y }))
    const t = svg('text', { x: PAD.l - 6, y: y + 4, 'text-anchor': 'end' }); t.textContent = nf.format((max * i) / 4); g.append(t)
  }
  g.append(svg('line', { class: 'base', x1: PAD.l, x2: W - PAD.r, y1: PAD.t + ih, y2: PAD.t + ih }))
  const iw = W - PAD.l - PAD.r
  const every = Math.max(1, Math.ceil(labels.length / 7))
  labels.forEach((b, i) => {
    const last = i === labels.length - 1
    if (i % every && !(last && i % every >= every / 2)) return
    const x = PAD.l + (labels.length === 1 ? iw / 2 : (iw * i) / (labels.length - 1))
    const t = svg('text', { x, y: H - 6, 'text-anchor': i === 0 ? 'start' : last ? 'end' : 'middle' })
    t.textContent = shortLabel(b, by)
    g.append(t)
  })
}

/** Line chart, one tooltip listing every series at the hovered x (crosshair). */
function lineChart(labels, series, by, w = 780) {
  W = w
  const width = w // the pointer handler below runs after other charts have changed W
  const box = svg('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img' })
  const max = niceMax(Math.max(1, ...series.flatMap((s) => s.values)))
  const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b
  const X = (i) => PAD.l + (labels.length === 1 ? iw / 2 : (iw * i) / (labels.length - 1))
  const Y = (v) => PAD.t + ih - (ih * v) / max
  axes(box, max, labels, by)
  const last = labels.length - 1
  for (const s of series) {
    const d = s.values.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join('')
    box.append(svg('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }))
  }
  // Direct labels: the period total of each series, in a column right of the plot, never overlapping.
  const tags = series.map((s) => ({ s, y: Y(s.values[last]) })).sort((a, b) => a.y - b.y)
  tags.forEach((t, k) => { if (k && t.y - tags[k - 1].y < 14) t.y = tags[k - 1].y + 14 })
  for (const t of tags) {
    const txt = svg('text', { x: X(last) - 6, y: t.y - 6, 'text-anchor': 'end', class: 'lbl' })
    txt.textContent = `${t.s.label}: ${nf.format(t.s.values.reduce((a, v) => a + v, 0))}`
    box.append(txt)
  }
  const hair = svg('line', { class: 'hair', y1: PAD.t, y2: PAD.t + ih, visibility: 'hidden' })
  const dots = series.map((s) => svg('circle', { r: 4, fill: s.color, stroke: css('--card'), 'stroke-width': 2, visibility: 'hidden' }))
  box.append(hair, ...dots)
  const hit = svg('rect', { class: 'hit', x: PAD.l, y: PAD.t, width: iw, height: ih, tabindex: 0 })
  const at = (i, evt) => {
    hair.setAttribute('x1', X(i)); hair.setAttribute('x2', X(i)); hair.setAttribute('visibility', 'visible')
    dots.forEach((dot, k) => { dot.setAttribute('cx', X(i)); dot.setAttribute('cy', Y(series[k].values[i])); dot.setAttribute('visibility', 'visible') })
    showTip(evt, longLabel(labels[i], by), series.map((s) => ({ color: s.color, value: nf.format(s.values[i]), label: s.label })))
  }
  hit.addEventListener('pointermove', (evt) => {
    const r = box.getBoundingClientRect()
    const x = ((evt.clientX - r.left) / r.width) * width
    at(Math.max(0, Math.min(labels.length - 1, Math.round(((x - PAD.l) / iw) * (labels.length - 1)))), evt)
  })
  let kb = labels.length - 1
  hit.addEventListener('keydown', (evt) => {
    if (evt.key !== 'ArrowLeft' && evt.key !== 'ArrowRight') return
    kb = Math.max(0, Math.min(labels.length - 1, kb + (evt.key === 'ArrowRight' ? 1 : -1)))
    const r = box.getBoundingClientRect()
    at(kb, { clientX: r.left + (X(kb) / width) * r.width, clientY: r.top + 20 })
  })
  const off = () => { hair.setAttribute('visibility', 'hidden'); dots.forEach((d) => d.setAttribute('visibility', 'hidden')); hideTip() }
  hit.addEventListener('pointerleave', off); hit.addEventListener('blur', off)
  box.append(hit)
  return box
}

/** Bars, stacked when there are several series; each segment is its own hover/focus target. */
function barChart(labels, series, { by = 'day', fmt = nf.format, labelOf, w = 580 } = {}) {
  W = w
  const box = svg('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img' })
  const totals = labels.map((_, i) => series.reduce((a, s) => a + s.values[i], 0))
  const max = niceMax(Math.max(1, ...totals))
  const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b
  const slot = iw / labels.length
  const bw = Math.max(2, Math.min(36, slot * 0.7))
  const Y = (v) => (ih * v) / max
  // y axis
  for (let i = 0; i <= 4; i++) {
    const y = PAD.t + ih - (ih * i) / 4
    if (i > 0) box.append(svg('line', { class: 'grid', x1: PAD.l, x2: W - PAD.r, y1: y, y2: y }))
    const t = svg('text', { x: PAD.l - 6, y: y + 4, 'text-anchor': 'end' }); t.textContent = fmt((max * i) / 4); box.append(t)
  }
  box.append(svg('line', { class: 'base', x1: PAD.l, x2: W - PAD.r, y1: PAD.t + ih, y2: PAD.t + ih }))
  const every = Math.max(1, Math.ceil(labels.length / 8))
  labels.forEach((b, i) => {
    const cx = PAD.l + slot * i + slot / 2
    let y0 = PAD.t + ih
    series.forEach((s, k) => {
      const h = Y(s.values[i])
      if (h <= 0) return
      const top = k === series.length - 1 || series.slice(k + 1).every((t) => !t.values[i])
      const gap = k > 0 ? 2 : 0
      const r = svg('rect', { class: 'bar', x: cx - bw / 2, y: y0 - h + gap, width: bw, height: Math.max(1, h - gap), fill: s.color, rx: top ? Math.min(4, bw / 2) : 0 })
      y0 -= h
      r.setAttribute('tabindex', 0)
      const tipFor = (evt) => showTip(evt, labelOf ? labelOf(b) : longLabel(b, by), series.map((t) => ({ color: t.color, value: fmt(t.values[i]), label: t.label })))
      r.addEventListener('pointermove', tipFor)
      r.addEventListener('focus', () => { const rr = r.getBoundingClientRect(); tipFor({ clientX: rr.right, clientY: rr.top }) })
      r.addEventListener('pointerleave', hideTip); r.addEventListener('blur', hideTip)
      box.append(r)
    })
    const lastBar = i === labels.length - 1
    if (i % every === 0 || (lastBar && i % every >= every / 2)) {
      const t = svg('text', { x: cx, y: H - 6, 'text-anchor': 'middle' }); t.textContent = labelOf ? labelOf(b) : shortLabel(b, by); box.append(t)
    }
  })
  return box
}

function legend(series, kind = 'rect') {
  if (series.length < 2) return null
  const ul = el('ul', { class: 'legend' })
  for (const s of series) {
    const i = el('i', { class: kind === 'line' ? 'line' : '' }); i.style.background = s.color
    ul.append(el('li', {}, i, document.createTextNode(s.label)))
  }
  return ul
}

function table(head, rows) {
  const t = el('table', { class: 'data' })
  const tr = el('tr'); head.forEach((h, i) => tr.append(el('th', { class: i ? 'n' : '', text: h })))
  t.append(el('thead', {}, tr))
  const tb = el('tbody')
  for (const r of rows) {
    const row = el('tr'); r.forEach((c, i) => row.append(el('td', { class: i ? 'n' : '', text: c })))
    tb.append(row)
  }
  t.append(tb)
  t.hidden = !state.tables
  return t
}

function card(title, sub, cls, ...body) {
  return el('section', { class: `card ${cls}` }, el('h2', { text: title }), sub ? el('p', { class: 'sub', text: sub }) : null, ...body)
}

// ---------- KPIs ----------
function delta(now, prev) {
  if (!prev && !now) return null
  const d = now - (prev || 0)
  const s = el('span', { class: `delta ${d > 0 ? 'up' : d < 0 ? 'down' : ''}`, text: `${d > 0 ? '▲' : d < 0 ? '▼' : '•'} ${nf.format(Math.abs(d))}` })
  s.title = 'Rispetto al periodo precedente'
  return s
}
function kpi(value, label, d) {
  return el('div', { class: 'kpi' }, el('b', { text: value }, d), el('span', { text: label }))
}

// ---------- render ----------
function render() {
  const s = state.data
  if (!s) return
  const by = s.bucket
  const labels = buckets(s.days, by)
  const color = { s1: css('--s1'), s2: css('--s2'), s3: css('--s3') }
  const period = s.days === 365 ? 'negli ultimi 12 mesi' : `negli ultimi ${s.days} giorni`
  const codes = s.codes.filter((c) => state.kind === 'all' || c.kind === state.kind)
  const sum = (rows, k) => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0)
  const reg = s.registrationsOpen
  const p = s.photos
  const used = p.cap ? Math.min(100, (100 * p.counted) / p.cap) : 0

  const frag = document.createDocumentFragment()

  // KPI row
  frag.append(el('div', { class: 'kpis' },
    kpi(n(s.families.total), `famiglie · ${n(s.families.inRange)} nuove ${period}`, delta(s.families.inRange, s.families.prevRange)),
    kpi(n(s.devices.total), `telefoni · ${n(s.devices.inRange)} nuovi ${period}`, delta(s.devices.inRange, s.devices.prevRange)),
    kpi(n(s.devices.activeInRange), `telefoni attivi ${period}`),
    kpi(n(sum(codes, 'inRange')), `codici emessi ${period}`, delta(sum(codes, 'inRange'), sum(codes, 'prevRange'))),
    kpi(eur.format(s.salesByMonth.reduce((a, m) => a + m.eur, 0)), 'vendite Stripe lorde, ultimi 12 mesi (stima a listino)'),
    kpi(gb(p.counted), `spazio foto · ${used.toFixed(1)}% del tetto`),
  ))

  const cards = el('div', { class: 'cards' })

  // Registrations switch
  const sw = card(`Nuove registrazioni: ${reg ? 'aperte' : 'bloccate'}`, null, `w4 switch ${reg ? '' : 'closed'}`,
    el('p', { text: reg ? 'Si possono creare famiglie nuove e aggiungere telefoni con un invito.' : 'Nessuna famiglia nuova, nessun telefono nuovo, nessuna vendita di famiglie. Le famiglie esistenti si sincronizzano e il kit di recupero funziona.' }),
    el('button', { type: 'button', class: 'primary', id: 'reg-toggle', 'data-open': reg ? 'false' : 'true', text: reg ? 'Blocca le nuove registrazioni' : 'Riapri le registrazioni' }))
  cards.append(sw)

  // Storage meter
  const meter = el('div', { class: `meter ${used > 85 ? 'hot' : ''}`, role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': used.toFixed(1), 'aria-label': 'Spazio foto usato' })
  const fill = el('i'); fill.style.width = `${used}%`; meter.append(fill)
  cards.append(card('Spazio foto sul server', `${gb(p.counted)} su ${gb(p.cap)} · ${n(p.ready)} foto, ${n(p.pending)} in caricamento`, 'w4', meter,
    el('p', { class: 'sub', text: `${n(s.records)} record cifrati · ${n(s.openInvites)} inviti aperti` })))

  // Today's write budget
  const b = s.budgetToday || {}
  cards.append(card('Scritture di oggi', 'Budget giornaliero per telefono: 5.000 unità (record 1, foto 4)', 'w4',
    el('div', { class: 'kpis' }, kpi(n(b.devices), 'telefoni che hanno scritto'), kpi(n(b.top), 'unità del più attivo')),
  ))

  // Growth
  const fam = toMap(s.series.newFamilies), dev = toMap(s.series.newDevices), seen = toMap(s.series.lastSeen)
  const growth = [
    { label: 'Famiglie nuove', color: color.s1, values: labels.map((x) => fam.get(x) || 0) },
    { label: 'Telefoni nuovi', color: color.s2, values: labels.map((x) => dev.get(x) || 0) },
  ]
  cards.append(card('Crescita', `Famiglie e telefoni aggiunti ${period}, per ${by === 'month' ? 'mese' : 'giorno'}`, 'w8',
    legend(growth, 'line'), lineChart(labels, growth, by, WIDTH.w8),
    table([by === 'month' ? 'Mese' : 'Giorno', ...growth.map((g) => g.label)], labels.map((x, i) => [longLabel(x, by), ...growth.map((g) => n(g.values[i]))]))))

  // Last seen
  const seenS = [{ label: 'Telefoni visti per l’ultima volta', color: color.s1, values: labels.map((x) => seen.get(x) || 0) }]
  cards.append(card('Ultimo accesso', 'Telefoni per giorno del loro ultimo contatto', 'w4',
    barChart(labels, seenS, { by, w: WIDTH.w4 }),
    table([by === 'month' ? 'Mese' : 'Giorno', 'Telefoni'], labels.map((x, i) => [longLabel(x, by), n(seenS[0].values[i])]))))

  // Codes over time, stacked by source
  const codeRows = s.series.codes.filter((c) => state.kind === 'all' || c.kind === state.kind)
  const bySource = (src) => labels.map((x) => codeRows.filter((c) => c.b === x && c.source === src).reduce((a, c) => a + c.issued, 0))
  const codeSeries = [
    { label: 'Stripe', color: color.s1, values: bySource('stripe') },
    { label: 'Manuali', color: color.s2, values: bySource('manual') },
  ]
  cards.append(card(`Codici emessi${state.kind === 'all' ? '' : ` · ${KIND[state.kind]}`}`, `Per origine, ${period}`, 'w8',
    legend(codeSeries), barChart(labels, codeSeries, { by, w: WIDTH.w8 }),
    table([by === 'month' ? 'Mese' : 'Giorno', 'Stripe', 'Manuali'], labels.map((x, i) => [longLabel(x, by), n(codeSeries[0].values[i]), n(codeSeries[1].values[i])]))))

  // Codes summary table
  const t = table(['Tipo · origine', 'Emessi', 'Usati', `Nel periodo`], codes.map((c) => [`${KIND[c.kind] ?? c.kind} · ${SOURCE[c.source] ?? c.source}`, n(c.issued), n(c.redeemed), n(c.inRange)]))
  t.hidden = false
  cards.append(card('Codici in totale', 'Emessi da sempre e usati; l’ultima colonna segue il periodo scelto', 'w4', codes.length ? t : el('p', { class: 'empty', text: 'Nessun codice' })))

  // Sales by month
  const months = [...s.salesByMonth].reverse()
  const salesS = [
    { label: 'Famiglia', color: color.s1, values: months.map((m) => m.family) },
    { label: 'Posto in più', color: color.s3, values: months.map((m) => m.slot) },
  ]
  cards.append(card('Vendite Stripe per mese', 'Codici venduti; il totale in euro è una stima a prezzo di listino', 'w6',
    months.length ? legend(salesS) : null,
    months.length ? barChart(months.map((m) => m.month), salesS, { by: 'month', w: WIDTH.w6 }) : el('p', { class: 'empty', text: 'Nessuna vendita' }),
    table(['Mese', 'Famiglia', 'Posto in più', 'Lordo stimato'], months.map((m) => [longLabel(m.month, 'month'), n(m.family), n(m.slot), eur.format(m.eur)]))))

  // Distributions
  const dist = (title, sub, rows, unit) => {
    const ser = [{ label: unit, color: color.s1, values: rows.map((r) => r.n) }]
    return card(title, sub, 'w6',
      barChart(rows.map((r) => r.label), ser, { labelOf: (x) => x, w: WIDTH.w6 }),
      table(['Fascia', 'Famiglie'], rows.map((r) => [r.label, n(r.n)])))
  }
  cards.append(dist('Telefoni per famiglia', 'Quante famiglie hanno 1, 2, 3… telefoni', s.distributions.phones, 'Famiglie'))
  cards.append(dist('Spazio foto per famiglia', 'Famiglie per fascia di MB occupati (tetto 300 MB)', s.distributions.photoMB, 'Famiglie'))
  cards.append(dist('Elementi per famiglia', 'Record cifrati per famiglia (capi, schede, categorie)', s.distributions.records, 'Famiglie'))

  frag.append(cards)
  out.replaceChildren(frag)
  for (const tbl of out.querySelectorAll('table.data')) if (tbl.closest('.card')?.querySelector('svg')) tbl.hidden = !state.tables
  at.textContent = `Aggiornato: ${new Date(s.at).toLocaleString('it-IT')}`
}

async function load() {
  at.textContent = 'Caricamento…'
  out.classList.add('loading')
  try {
    const res = await fetch(`/api/admin/stats?days=${state.days}`, { credentials: 'same-origin', cache: 'no-store' })
    if (!res.ok) throw new Error(res.status === 404 ? 'Accesso non autorizzato o dashboard non configurata.' : `Errore ${res.status}`)
    state.data = await res.json()
    render()
  } catch (e) {
    at.replaceChildren(el('span', { class: 'err', text: e.message }))
  } finally {
    out.classList.remove('loading')
  }
}

async function setRegistrations(open) {
  if (!open && !confirm('Bloccare le nuove registrazioni? Le famiglie esistenti non ne risentono.')) return
  at.textContent = 'Salvataggio…'
  try {
    const res = await fetch('/api/admin/registrations', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ open }),
    })
    if (!res.ok) throw new Error(`Errore ${res.status}`)
    await load()
  } catch (e) {
    at.replaceChildren(el('span', { class: 'err', text: e.message }))
  }
}

// ---------- resources (independent of the filters: always today, this month, last 30 days) ----------
function gauge(name, value, limit, fmt = n, per = 'oggi') {
  const pct = limit ? Math.min(100, (100 * value) / limit) : 0
  const level = pct >= 90 ? 'hot' : pct >= 70 ? 'warn' : ''
  const m = el('div', { class: `meter ${level}`, role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': String(limit), 'aria-valuenow': String(value), 'aria-label': name })
  const f = el('i'); f.style.width = `${pct}%`; m.append(f)
  const stateText = level === 'hot' ? 'Vicino al limite' : level === 'warn' ? 'Da tenere d’occhio' : 'Nella norma'
  return el('div', { class: 'res' },
    el('span', { class: 'name', text: name }),
    el('b', { text: fmt(value) }), el('span', { class: 'of', text: ` su ${fmt(limit)} ${per} · ${pct.toFixed(pct < 1 ? 2 : 0)}%` }),
    m, el('span', { class: `state ${level}`, text: stateText }))
}

function renderUsage(u) {
  const box = $('#res')
  const L = u.limits
  const today = new Date().toISOString().slice(0, 10)
  const frag = document.createDocumentFragment()
  const grid = el('div', { class: 'res-grid' })
  const cf = u.cloudflare || {}
  const d1Today = cf.d1?.find((r) => r.day === today) ?? { rowsRead: 0, rowsWritten: 0 }
  const wToday = cf.worker?.find((r) => r.day === today) ?? { requests: 0, errors: 0 }
  if (cf.configured && !cf.error) {
    grid.append(
      gauge('Richieste al Worker', wToday.requests, L.workerRequestsDay),
      gauge('D1 · righe scritte', d1Today.rowsWritten, L.d1RowsWrittenDay),
      gauge('D1 · righe lette', d1Today.rowsRead, L.d1RowsReadDay),
      gauge('R2 · operazioni classe A', cf.r2.classAMonth, L.r2ClassAMonth, n, 'nel mese'),
      gauge('R2 · operazioni classe B', cf.r2.classBMonth, L.r2ClassBMonth, n, 'nel mese'),
      gauge('R2 · spazio occupato', cf.r2.bytes, L.r2StorageBytes, gb, ''),
    )
  }
  // Resend: the whole account (other projects included) from Resend itself; A/R's own share below.
  const rs = u.resend || {}
  const fromResend = !rs.error && (rs.day != null || rs.month != null)
  const mine = (v) => el('span', { class: 'state', text: `di cui inviate da A/R: ${n(v)}` })
  const g1 = gauge('Email oggi · account Resend', fromResend ? rs.day ?? 0 : u.emails.today, L.emailsDay)
  const g2 = gauge('Email nel mese · account Resend', fromResend ? rs.month ?? 0 : u.emails.month, L.emailsMonth, n, 'nel mese')
  g1.append(el('br'), mine(u.emails.today)); g2.append(el('br'), mine(u.emails.month))
  grid.append(g1, g2)
  frag.append(grid)
  if (!fromResend) frag.append(el('p', { class: 'note', text: `Dati di Resend non disponibili (${rs.error || 'nessun dato'}): le email mostrate sono solo quelle inviate da A/R.` }))
  if (!cf.configured) {
    frag.append(el('p', { class: 'note', text: 'I dati di Cloudflare (Worker, D1, R2) compaiono quando il Worker ha il secret CF_ANALYTICS_TOKEN: un token API con il permesso “Account Analytics: Read”.' }))
  } else if (cf.error) {
    frag.append(el('p', { class: 'note', text: `Statistiche Cloudflare non disponibili: ${cf.error}` }))
  } else {
    const days = buckets(30, 'day')
    const color = { s1: css('--s1'), s2: css('--s2') }
    const pick = (rows, k) => { const m = new Map(rows.map((r) => [r.day, r[k]])); return days.map((d) => m.get(d) || 0) }
    const cards = el('div', { class: 'cards' })
    const wr = [{ label: 'Righe scritte', color: color.s1, values: pick(cf.d1, 'rowsWritten') }]
    const rq = [{ label: 'Richieste', color: color.s2, values: pick(cf.worker, 'requests') }]
    cards.append(
      card('D1 · righe scritte al giorno', `Ultimi 30 giorni · limite gratuito ${n(L.d1RowsWrittenDay)} al giorno`, 'w6', barChart(days, wr, { w: WIDTH.w6 }),
        table(['Giorno', 'Righe scritte', 'Righe lette'], days.map((d, i) => [longLabel(d, 'day'), n(wr[0].values[i]), n(pick(cf.d1, 'rowsRead')[i])]))),
      card('Worker · richieste al giorno', `Ultimi 30 giorni · limite gratuito ${n(L.workerRequestsDay)} al giorno`, 'w6', barChart(days, rq, { w: WIDTH.w6 }),
        table(['Giorno', 'Richieste', 'Errori'], days.map((d, i) => [longLabel(d, 'day'), n(rq[0].values[i]), n(pick(cf.worker, 'errors')[i])]))),
    )
    frag.append(cards)
  }
  box.replaceChildren(frag)
  for (const tbl of box.querySelectorAll('table.data')) tbl.hidden = !state.tables
}

async function loadUsage() {
  try {
    const res = await fetch('/api/admin/usage', { credentials: 'same-origin', cache: 'no-store' })
    if (!res.ok) throw new Error(`Errore ${res.status}`)
    state.usage = await res.json()
    renderUsage(state.usage)
  } catch (e) {
    $('#res').replaceChildren(el('p', { class: 'note', text: `Risorse non disponibili: ${e.message}` }))
  }
}

// ---------- filters ----------
$('#range').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-days]')
  if (!b) return
  for (const x of $('#range').querySelectorAll('button')) x.setAttribute('aria-checked', String(x === b))
  state.days = Number(b.dataset.days)
  load()
})
$('#kind').addEventListener('change', (e) => { state.kind = e.target.value; render() })
$('#tables').addEventListener('change', (e) => {
  state.tables = e.target.checked
  for (const tbl of document.querySelectorAll('main table.data')) if (tbl.closest('.card')?.querySelector('svg')) tbl.hidden = !state.tables
})
out.addEventListener('click', (e) => {
  const btn = e.target.closest('#reg-toggle')
  if (btn) setRegistrations(btn.dataset.open === 'true')
})
$('#reload').addEventListener('click', () => { load(); loadUsage() })
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { render(); if (state.usage) renderUsage(state.usage) })
load()
loadUsage()
