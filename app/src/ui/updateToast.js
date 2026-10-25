// "New version available" notice above the bottom bar.
import { t, onLangChange } from '../i18n.js'
import { isBusy } from '../store.js'
import { canApplyUpdate } from '../update.js'
import { isAdding } from './add.js'

/** Read the live app state. The busy overlay is a dialog too, so it counts as a modal. */
const readState = () => ({
  modalOpen: !!document.querySelector('dialog[open]'),
  viewerOpen: !!document.querySelector('#viewer:not([hidden])'), // also covers a pending rotation
  busy: isBusy() || isAdding(),
})

/** @param {(h: {onNeedRefresh: () => void, onOfflineReady: () => void}) => (reload?: boolean) => Promise<void>} register */
export function initUpdateToast(register, { poll = 500, reload = () => location.reload() } = {}) {
  let timer = null
  let el = null
  const updateSW = register({ onNeedRefresh: show, onOfflineReady() {}, onNeedReload })

  // The new worker took control (here or in another tab): the plugin would reload at once and
  // drop dialogs or photos in progress. Wait for idle instead, even if the toast was dismissed.
  let reloadTimer = null
  function onNeedReload() {
    if (reloadTimer) return
    const tryReload = () => {
      if (!canApplyUpdate(readState())) return
      clearInterval(reloadTimer)
      reload()
    }
    reloadTimer = setInterval(tryReload, poll)
    tryReload()
  }

  function sync() {
    const idle = canApplyUpdate(readState())
    const go = el.querySelector('.up-go')
    go.disabled = !idle
    el.querySelector('.hint').hidden = idle
  }
  function draw() {
    el.innerHTML = `<span class="msg">${t('update.available')}<span class="hint" hidden>${t('update.busy')}</span></span>
      <button type="button" class="up-go">${t('update.action')}</button>
      <button type="button" class="up-x" aria-label="${t('common.close')}">✕</button>`
    sync()
  }
  function hide() { clearInterval(timer); el?.remove(); el = null }
  function show() {
    if (el) return
    el = document.createElement('aside')
    el.className = 'update-toast'
    el.setAttribute('role', 'status')
    el.addEventListener('click', (e) => {
      if (e.target.closest('.up-x')) return hide() // hidden for this session only
      const go = e.target.closest('.up-go')
      if (go && !go.disabled && canApplyUpdate(readState())) updateSW(true) // skipWaiting + reload
    })
    draw()
    document.body.append(el)
    timer = setInterval(sync, poll) // dialogs open and close all over the app: polling beats hooking each one
  }
  onLangChange(() => { if (el) draw() })
  return { show, hide }
}
