import '@fontsource/plus-jakarta-sans/500.css';
import '@fontsource/plus-jakarta-sans/600.css';
import '@fontsource/plus-jakarta-sans/700.css';
import './styles.css';
import { openDb } from './db.js';
import { store, load, subscribe } from './store.js';
import { renderApp } from './ui/render.js';
import { watchClipboard } from './ui/clipboard.js';
import { initAddFlow } from './ui/add.js';

const root = document.getElementById('app');

function draw() {
  if (store.tabs.length) renderApp(root, store);
  else root.textContent = 'Andata e Ritorno'; // Task 10 adds the welcome screen
}

const db = await openDb();
subscribe(draw);
await load(db);
watchClipboard(draw);
initAddFlow();
