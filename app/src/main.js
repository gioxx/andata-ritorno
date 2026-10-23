import '@fontsource/plus-jakarta-sans/500.css';
import '@fontsource/plus-jakarta-sans/600.css';
import '@fontsource/plus-jakarta-sans/700.css';
import './styles.css';
import { openDb } from './db.js';
import { store, load, subscribe, addTab } from './store.js';
import { renderApp, hooks } from './ui/render.js';
import { renderWelcome } from './ui/welcome.js';
import { initTabs } from './ui/tabs.js';
import { reportError } from './ui/dialogs.js';
import { watchClipboard } from './ui/clipboard.js';
import { initAddFlow } from './ui/add.js';
import { initViewer } from './ui/viewer.js';

const root = document.getElementById('app');

// Ask the browser not to evict our data; never throws, the answer is not needed.
function persist() {
  try { navigator.storage?.persist?.().catch(() => {}) } catch { /* unsupported */ }
}

function draw() {
  if (store.tabs.length) renderApp(root, store);
  else if (!root.querySelector('.welcome')) { // draw once: a redraw would drop focus while typing
    renderWelcome(root, {
      onCreate: (name) => { persist(); addTab(name).catch(reportError) },
      onImport: (file) => { persist(); Promise.resolve(hooks.onImportFile(file)).catch(reportError) },
    })
  }
}

const db = await openDb();
subscribe(draw);
await load(db);
watchClipboard(draw);
initAddFlow();
initTabs();
initViewer();
