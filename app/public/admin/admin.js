// Owner dashboard: renders /api/admin/stats (aggregate numbers only; behind Cloudflare Access)
// and holds the switch that closes new registrations in an emergency.
const out = document.getElementById('out')
const at = document.getElementById('at')
const nf = new Intl.NumberFormat('it-IT')
const n = (v) => nf.format(Number(v) || 0)
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const gb = (b) => `${(Number(b) / 1e9).toLocaleString('it-IT', { maximumFractionDigits: 2 })} GB`
const tile = (value, label) => `<div class="tile"><b>${value}</b><span>${esc(label)}</span></div>`
const KIND = { family: 'Famiglia', slot: 'Posto in più' }
const SOURCE = { stripe: 'Stripe', manual: 'Manuale' }

function render(s) {
  const p = s.photos
  const used = p.cap ? Math.min(100, (100 * p.counted) / p.cap) : 0
  const reg = s.registrationsOpen
  out.innerHTML = `
    <section class="switch ${reg ? '' : 'closed'}" aria-labelledby="reg-h">
      <h2 id="reg-h">Nuove registrazioni: ${reg ? 'aperte' : 'bloccate'}</h2>
      <p>${reg
        ? 'Si possono creare famiglie nuove e aggiungere telefoni con un invito.'
        : 'Nessuna famiglia nuova, nessun telefono nuovo (né con un invito né ripartendo da una licenza). Le famiglie esistenti continuano a sincronizzarsi e il kit di recupero funziona. Chi paga riceve comunque il codice: potrà usarlo alla riapertura.'}</p>
      <button type="button" id="reg-toggle" data-open="${reg ? 'false' : 'true'}">${reg ? 'Blocca le nuove registrazioni' : 'Riapri le registrazioni'}</button>
    </section>
    <h2>Famiglie e telefoni</h2>
    <div class="grid">
      ${tile(n(s.families.total), 'famiglie')}
      ${tile(n(s.families.new30), 'nuove negli ultimi 30 giorni')}
      ${tile(n(s.devices.total), 'telefoni collegati')}
      ${tile(n(s.devices.active1), 'attivi nelle ultime 24 ore')}
      ${tile(n(s.devices.active7), 'attivi negli ultimi 7 giorni')}
      ${tile(n(s.devices.active30), 'attivi negli ultimi 30 giorni')}
      ${tile(n(s.licences.total), 'licenze')}
      ${tile(n(s.licences.extraSlots), 'posti in più attivati')}
      ${tile(n(s.openInvites), 'inviti aperti')}
    </div>
    <h2>Dati</h2>
    <div class="grid">
      ${tile(n(s.records), 'record cifrati')}
      ${tile(n(p.ready), 'foto')}
      ${tile(n(p.pending), 'foto in caricamento')}
      ${tile(gb(p.counted), p.cap ? `su ${gb(p.cap)} disponibili` : 'occupati')}
    </div>
    ${p.cap ? `<div class="bar" role="img" aria-label="Spazio foto usato: ${used.toFixed(1)}%"><i></i></div>` : ''}
    <h2>Codici</h2>
    <table><thead><tr><th>Tipo</th><th>Origine</th><th class="n">Emessi</th><th class="n">Usati</th><th class="n">Ultimi 30 gg</th></tr></thead>
    <tbody>${s.codes.map((c) => `<tr><td>${esc(KIND[c.kind] ?? c.kind)}</td><td>${esc(SOURCE[c.source] ?? c.source)}</td><td class="n">${n(c.issued)}</td><td class="n">${n(c.redeemed)}</td><td class="n">${n(c.last30)}</td></tr>`).join('') || '<tr><td colspan="5">Nessun codice</td></tr>'}</tbody></table>
    <h2>Vendite Stripe per mese</h2>
    <table><thead><tr><th>Mese</th><th class="n">Famiglie</th><th class="n">Posti in più</th></tr></thead>
    <tbody>${s.salesByMonth.map((m) => `<tr><td>${esc(m.month)}</td><td class="n">${n(m.family)}</td><td class="n">${n(m.slot)}</td></tr>`).join('') || '<tr><td colspan="3">Nessuna vendita</td></tr>'}</tbody></table>`
  // The CSP blocks inline style attributes: the width goes through CSSOM.
  const bar = out.querySelector('.bar > i')
  if (bar) bar.style.width = `${used}%`
  at.textContent = `Aggiornato: ${new Date(s.at).toLocaleString('it-IT')}`
}

async function load() {
  at.textContent = 'Caricamento…'
  try {
    const res = await fetch('/api/admin/stats', { credentials: 'same-origin', cache: 'no-store' })
    if (!res.ok) throw new Error(res.status === 404 ? 'Accesso non autorizzato o cruscotto non configurato.' : `Errore ${res.status}`)
    render(await res.json())
  } catch (e) {
    at.innerHTML = `<span class="err">${esc(e.message)}</span>`
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
    at.innerHTML = `<span class="err">${esc(e.message)}</span>`
  }
}

out.addEventListener('click', (e) => {
  const btn = e.target.closest('#reg-toggle')
  if (btn) setRegistrations(btn.dataset.open === 'true')
})
document.getElementById('reload').addEventListener('click', load)
load()
