// Version + credits shown in the menu drawer and on the desktop invite.
import { linkIcon } from './icons.js'

export const REPO_URL = 'https://github.com/gioxx/andata-ritorno'
/** Injected by Vite `define` from package.json; guarded so bare-node imports don't throw. */
export const VERSION = typeof __APP_VERSION__ === 'undefined' ? 'dev' : __APP_VERSION__

const repoLink = `<a href="${REPO_URL}" target="_blank" rel="noopener">${linkIcon}Codice su GitHub</a>`

/** Footer of the side menu: three short lines. */
export const menuFooter = () => `<footer class="about">
    <div>Andata e Ritorno · versione ${VERSION}</div>
    <div>Sviluppata da Giovanni Solone</div>
    <div>${repoLink}</div>
  </footer>`

/** One-line footer for the desktop invite. */
export const inviteFooter = () => `<p class="about">Andata e Ritorno · versione ${VERSION} · ${repoLink}</p>`
