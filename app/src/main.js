import '@fontsource/plus-jakarta-sans/500.css';
import '@fontsource/plus-jakarta-sans/600.css';
import '@fontsource/plus-jakarta-sans/700.css';
import './styles.css';
import { openDb, setVersionChangeHandler } from './db.js';
import { store, load, subscribe, addTab } from './store.js';
import { renderApp, hooks } from './ui/render.js';
import { renderWelcome } from './ui/welcome.js';
import { initTabs } from './ui/tabs.js';
import { reportError } from './ui/dialogs.js';
import { watchClipboard } from './ui/clipboard.js';
import { initAddFlow } from './ui/add.js';
import { initViewer } from './ui/viewer.js';
import { initMenu } from './ui/menu.js';
import { desktopGate } from './ui/desktop.js';
import { t, onLangChange } from './i18n.js';

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
let db = null;
try {
  db = await openDb();
  // A newer tab wants to upgrade the DB: our connection is closed, so reload onto the new code.
  setVersionChangeHandler(() => location.reload());
} catch {
  root.innerHTML = `<div class="welcome">
    <h1>${t('main.storageFailed.title')}</h1>
    <p>${t('main.storageFailed.body')}</p>
  </div>`;
}
if (db) {
  subscribe(() => draw());
  onLangChange(() => draw(true)); // dialogs rebuild themselves lazily
  await load(db);
  watchClipboard(draw);
  initAddFlow();
  initTabs();
  initViewer();
  initMenu(db);
}
