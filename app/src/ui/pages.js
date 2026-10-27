// Pages reached from outside the app: the Stripe success page (/unlock) and, in iOS Safari, the
// hand-off for /join and /licence links. Safari and the installed Home-screen app keep separate
// storage, so a link opened in Safari must be copied into the installed app to reach its data.
import { t } from '../i18n.js'
import { esc } from './esc.js'
import { familyError } from './familyMenu.js'

/** Copy `text`, then show `okText` (or the failure) in `out`. */
async function copyInto(out, text, okText) {
  try {
    await navigator.clipboard.writeText(text)
    out.textContent = okText
  } catch {
    out.textContent = t('family.copyFailed')
  }
}

/**
 * /unlock?session_id=…: ask the Worker for the code of a paid Checkout Session and show it.
 * @param {HTMLElement} root
 * @param {{ api: {unlockSession:(id:string)=>Promise<{code:string, kind:string}>}, sessionId: string, inSafari: boolean }} o
 *   inSafari: iOS outside the installed app (the code has to be carried over by hand)
 */
export async function renderUnlockPage(root, { api, sessionId, inSafari }) {
  root.innerHTML = `<div class="welcome page">
    <h1>${t('page.unlock.title')}</h1>
    <div id="unlockBody"><p>${t('sync.syncing')}</p></div>
    <a class="pageLink" href="/">${t('page.openApp')}</a>
  </div>`
  const body = root.querySelector('#unlockBody')
  const draw = async () => {
    body.innerHTML = `<p>${t('sync.syncing')}</p>`
    let res
    try {
      if (!sessionId) throw Object.assign(new Error('bad-session'), { code: 'bad-session' })
      res = await api.unlockSession(sessionId)
    } catch (e) {
      // Not paid yet (e.g. a delayed payment method) or offline may change: offer a retry.
      body.innerHTML = `<p class="err" role="alert">${esc(familyError(e))}</p>${e?.code === 'bad-session' ? '' : `<button type="button" data-retry>${t('family.retry')}</button>`}`
      return
    }
    body.innerHTML = `<p class="unlockCode" id="unlockCode">${esc(res.code)}</p>
      <button type="button" class="primary" data-copy>${t('page.unlock.copy')}</button>
      <p class="pageNote" role="status"></p>
      <p>${t('page.unlock.body')}</p>${inSafari ? `<p>${t('page.unlock.ios')}</p>` : ''}`
    body.querySelector('[data-copy]').addEventListener('click', () => copyInto(body.querySelector('.pageNote'), res.code, t('page.copied')))
  }
  body.addEventListener('click', (e) => { if (e.target.closest('[data-retry]')) draw() })
  await draw()
}

/**
 * iOS Safari landing for /join or /licence: copy the link for the installed app, or carry on here
 * (A/R not installed: Safari is the app then).
 * @param {HTMLElement} root
 * @param {{ kind: 'join'|'licence', link: string }} o
 * @returns {Promise<void>} resolves when the user chooses to continue in Safari
 */
export function renderHandoff(root, { kind, link }) {
  root.innerHTML = `<div class="welcome page">
    <h1>${t(`page.${kind}.title`)}</h1>
    <p>${t(`page.${kind}.body`)}</p>
    <button type="button" class="primary" data-copy>${t(`page.${kind}.copy`)}</button>
    <p class="pageNote" role="status"></p>
    <button type="button" class="ghost" data-here>${t('page.continue')}</button>
  </div>`
  root.querySelector('[data-copy]').addEventListener('click', () => copyInto(root.querySelector('.pageNote'), link, t('page.copied')))
  return new Promise((resolve) => {
    root.querySelector('[data-here]').addEventListener('click', () => { root.innerHTML = ''; resolve() }, { once: true })
  })
}
