import '@fontsource/plus-jakarta-sans/500.css';
import '@fontsource/plus-jakarta-sans/600.css';
import '@fontsource/plus-jakarta-sans/700.css';
import './styles.css';
import { openDb, setVersionChangeHandler } from './db.js';
import { getFamily } from './sync/family.js';
import { createApi } from './sync/api.js';
import { initSync, syncNow, subscribeSync } from './sync/engine.js';
import { enableSyncLine, initPullToRefresh } from './ui/syncLine.js';
import { store, load, subscribe, addTab } from './store.js';
import { renderApp, hooks } from './ui/render.js';
import { renderWelcome } from './ui/welcome.js';
import { initTabs } from './ui/tabs.js';
import { initCategories } from './ui/categories.js';
import { reportError } from './ui/dialogs.js';
import { watchClipboard } from './ui/clipboard.js';
import { initAddFlow } from './ui/add.js';
import { initViewer } from './ui/viewer.js';
import { initMenu } from './ui/menu.js';
import { initFamilyUi } from './ui/familyDialogs.js';
import { desktopGate } from './ui/desktop.js';
import { initIosBanner } from './ui/iosBanner.js';
import { registerSW } from 'virtual:pwa-register';
import { initUpdateToast } from './ui/updateToast.js';
import { initInstall } from './install.js';
import { initInstallStrip } from './ui/installStrip.js';
import { t, onLangChange } from './i18n.js';

// A waiting version is announced, never applied by surprise; ignored, it applies on the next full reopen.
initUpdateToast((handlers) => registerSW(handlers));
initInstall(); // the browser may fire beforeinstallprompt before the UI is ready
const root = document.getElementById('app');
await desktopGate(root);

// Ask the browser not to evict our data; never throws, the answer is not needed.
function persist() {
  try { navigator.storage?.persist?.().catch(() => {}) } catch { /* unsupported */ }
}

// `force` = redraw even the welcome screen (language change); it keeps the typed name.
function draw(force = false) {
  if (store.tabs.length) renderApp(root, store);
  else if (force || !root.querySelector('.welcome')) { // draw once: a redraw would drop focus while typing
    renderWelcome(root, {
      onCreate: (name) => { persist(); addTab(name).catch(reportError) },
      onImport: (file) => { persist(); Promise.resolve(hooks.onImportFile(file)).catch(reportError) },
    })
  }
}

// IndexedDB can be blocked (private mode, site data disabled): say so instead of a blank page.
const storageScreen = (body) => {
  root.innerHTML = `<div class="welcome">
    <h1>${t('main.storageFailed.title')}</h1>
    <p>${body}</p>
  </div>`;
};
let db = null;
let blocked = false;
try {
  // An older A/R tab holding the DB open keeps the upgrade waiting: ask the user to close it.
  db = await openDb(undefined, { onBlocked: () => { blocked = true; storageScreen(t('main.blocked.body')) } });
  // The other tab closed after all: drop the message (the welcome screen draws only into an empty root).
  if (blocked) root.textContent = '';
  // A newer tab wants to upgrade the DB: our connection is closed, so reload onto the new code.
  setVersionChangeHandler(() => location.reload());
} catch {
  storageScreen(t('main.storageFailed.body'));
}
if (db) {
  subscribe(() => draw());
  onLangChange(() => draw(true)); // dialogs rebuild themselves lazily
  await load(db);
  // Banner steps move to the welcome screen once dismissed: force a redraw (it keeps the typed name).
  initIosBanner({ onDismiss: () => draw(true) });
  initInstallStrip();
  watchClipboard(draw);
  initAddFlow();
  initTabs();
  initCategories();
  initViewer();
  initMenu(db);
  // Only a device in a family touches the network, and only after the first render.
  const api = createApi({ getToken: async () => (await getFamily(db))?.token });
  let inFamily = false; // keyed on membership, not on sync state: a removed phone still is in a family
  let wired = false;
  // Also called from the menu right after a family is created (no reload needed).
  const startSync = async () => {
    inFamily = true;
    enableSyncLine(true);
    hooks.onSyncLine = () => syncNow('line');
    await initSync({ db, api });
    if (!wired) {
      wired = true;
      subscribeSync(() => { document.documentElement.classList.toggle('in-family', inFamily); draw(); });
      initPullToRefresh(document.scrollingElement ?? document.documentElement, () => syncNow('pull'));
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncNow('visible'); });
    }
    draw();
    syncNow('start');
  };
  // The engine stays up but idle: with no family its run resets the status and touches nothing.
  const stopSync = () => { inFamily = false; hooks.onSyncLine = () => {}; syncNow('menu'); draw(); };
  initFamilyUi({ db, api, onEntered: startSync, onLeft: stopSync });
  if (await getFamily(db)) await startSync();
}
