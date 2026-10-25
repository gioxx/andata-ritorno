// Version + credits shown in the menu drawer and on the desktop invite.
import { linkIcon } from './icons.js'
import { t } from '../i18n.js'

export const REPO_URL = 'https://github.com/gioxx/andata-ritorno'
/** Injected by Vite `define` from package.json; guarded so bare-node imports don't throw. */
export const VERSION = typeof __APP_VERSION__ === 'undefined' ? 'dev' : __APP_VERSION__

const repoLink = () => `<a href="${REPO_URL}" target="_blank" rel="noopener">${linkIcon}${t('about.github')}</a>`

/** Footer of the side menu: three short lines. */
export const menuFooter = () => `<footer class="about">
    <div>${t('about.version', { version: VERSION })}</div>
    <div>${t('about.author')}</div>
    <div>${repoLink()}</div>
  </footer>`

/** One-line footer for the desktop invite. */
export const inviteFooter = () => `<p class="about">${t('about.version', { version: VERSION })} · ${repoLink()}</p>`
