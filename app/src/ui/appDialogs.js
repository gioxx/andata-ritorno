// Info dialogs of the "App" menu section: manual install steps and how to uninstall.
import { t } from '../i18n.js'
import { installSteps, uninstallSteps, stepGroups, currentPlatform } from '../platform.js'
import { openModal } from './dialogs.js'

/** Build, show and (once closed) discard a dialog with a title, body html and a close button. */
function showInfo(title, bodyHtml) {
  const d = document.createElement('dialog')
  d.innerHTML = `<form method="dialog"><h3>${title}</h3>${bodyHtml}<button value="" class="cancel">${t('common.close')}</button></form>`
  document.body.append(d)
  d.addEventListener('close', () => d.remove(), { once: true })
  openModal(d)
  return d
}

const groupsHtml = (groups) => groups.map((g) => `${groups.length > 1 ? `<p class="steps-title">${t(g.platform === 'ios' ? 'install.iosTitle' : 'install.androidTitle')}</p>` : ''}<ol class="steps">${g.keys.map((k) => `<li>${t(k)}</li>`).join('')}</ol>`).join('')

/** Manual "add to Home screen" steps (the browser offered no native prompt). */
export const openInstallSteps = (platform = currentPlatform()) =>
  showInfo(t('install.dialogTitle'), groupsHtml(stepGroups(platform, installSteps)))

/** Uninstall steps plus the reminder that data stays until "Delete all data". */
export const openUninstallSteps = (platform = currentPlatform()) =>
  showInfo(t('uninstall.title'), `${groupsHtml(stepGroups(platform, uninstallSteps))}<p class="note">${t('uninstall.notice')}</p>`)
