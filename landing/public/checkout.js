// Buy without leaving the page: Stripe's embedded Checkout opens in a dialog over the site.
// Stripe.js is loaded only when someone presses a buy button, so the page sends nothing to Stripe
// before that. Without JavaScript, or if anything here fails, the buttons stay plain links to the
// Stripe payment pages.
const API = 'https://app.ar.gxware.org'
const KEY = document.querySelector('meta[name="ar-stripe-key"]')?.content
const lang = document.documentElement.lang === 'it' ? 'it' : 'en'
const T = {
  it: { family: 'Condivisione in famiglia', slot: 'Un posto in più', close: 'Chiudi', loading: 'Apertura del pagamento…', failed: 'Il pagamento non si apre qui. Puoi completarlo sulla pagina di Stripe:', open: 'Apri la pagina di pagamento', closed: 'Le nuove attivazioni sono sospese per un po’. Riprova più tardi.', done: 'Pagamento completato', code: 'Il tuo codice', copy: 'Copia il codice', copied: 'Copiato', next: 'Ti arriva anche per email. Nell’app: Menu → Famiglia → Ho già un codice.', nextSlot: 'Ti arriva anche per email. Nell’app: Menu → Famiglia → Aggiungi un posto.', pending: 'Il pagamento è in elaborazione: il codice ti arriva per email appena è confermato.', app: 'Apri A/R' },
  en: { family: 'Family sharing', slot: 'One more seat', close: 'Close', loading: 'Opening the payment…', failed: 'The payment cannot open here. You can complete it on the Stripe page:', open: 'Open the payment page', closed: 'New activations are paused for a while. Try again later.', done: 'Payment complete', code: 'Your code', copy: 'Copy the code', copied: 'Copied', next: 'It also reaches you by email. In the app: Menu → Family → I already have a code.', nextSlot: 'It also reaches you by email. In the app: Menu → Family → Add a seat.', pending: 'The payment is being processed: the code reaches you by email as soon as it is confirmed.', app: 'Open A/R' },
}[lang]

let stripeReady = null
const loadStripe = () => (stripeReady ??= new Promise((resolve, reject) => {
  const s = document.createElement('script')
  s.src = 'https://js.stripe.com/endive/stripe.js'
  s.onload = () => (window.Stripe ? resolve(window.Stripe(KEY)) : reject(new Error('stripe.js')))
  s.onerror = () => { stripeReady = null; reject(new Error('stripe.js')) }
  document.head.append(s)
}))

const dlg = document.createElement('dialog')
dlg.className = 'checkout-dialog'
dlg.setAttribute('aria-labelledby', 'checkout-title')
dlg.innerHTML = `<div class="checkout-head"><h2 id="checkout-title"></h2><button type="button" class="checkout-close" aria-label="${T.close}"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button></div><div class="checkout-body" role="status"></div><div id="checkout-mount"></div>`
document.body.append(dlg)
const title = dlg.querySelector('#checkout-title')
const body = dlg.querySelector('.checkout-body')
const mount = dlg.querySelector('#checkout-mount')
let current = null

function reset() {
  current?.destroy()
  current = null
  mount.replaceChildren()
  body.replaceChildren()
}
dlg.querySelector('.checkout-close').addEventListener('click', () => dlg.close())
dlg.addEventListener('close', reset)
dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close() })

function say(text, link) {
  body.replaceChildren()
  const p = document.createElement('p')
  p.textContent = text
  body.append(p)
  if (link) {
    const a = document.createElement('a')
    a.className = 'btn btn-primary'
    a.href = link
    a.textContent = T.open
    body.append(a)
  }
}

async function showCode(kind, sessionId) {
  reset()
  title.textContent = T.done
  try {
    const res = await fetch(`${API}/api/unlock/session?id=${encodeURIComponent(sessionId)}`)
    if (!res.ok) throw new Error(String(res.status))
    const { code } = await res.json()
    body.innerHTML = `<p class="checkout-label">${T.code}</p><p class="checkout-code"></p><div class="actions"><button type="button" class="btn btn-ghost checkout-copy">${T.copy}</button><a class="btn btn-primary" href="https://app.ar.gxware.org/">${T.app}</a></div><p class="fine"></p>`
    body.querySelector('.checkout-code').textContent = code
    body.querySelector('.fine').textContent = kind === 'slot' ? T.nextSlot : T.next
    const copy = body.querySelector('.checkout-copy')
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(code); copy.textContent = T.copied } catch { /* the code stays on screen */ }
    })
  } catch {
    say(T.pending)
  }
}

async function open(kind, fallback) {
  reset()
  title.textContent = T[kind]
  say(T.loading)
  dlg.showModal()
  let sessionId = null
  try {
    const stripe = await loadStripe()
    const fetchClientSecret = async () => {
      const res = await fetch(`${API}/api/checkout`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind }) })
      const out = await res.json().catch(() => ({}))
      if (!res.ok) throw Object.assign(new Error(out.error || String(res.status)), { code: out.error })
      sessionId = out.sessionId
      return out.clientSecret
    }
    current = await stripe.createEmbeddedCheckoutPage({ fetchClientSecret, onComplete: () => showCode(kind, sessionId) })
    if (!dlg.open) { reset(); return }
    body.replaceChildren()
    current.mount(mount)
  } catch (e) {
    reset()
    if (e?.code === 'registrations-closed') say(T.closed)
    else say(T.failed, fallback)
  }
}

if (KEY) {
  for (const a of document.querySelectorAll('a[data-checkout]')) {
    a.addEventListener('click', (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
      e.preventDefault()
      open(a.dataset.checkout, a.href)
    })
  }
}
