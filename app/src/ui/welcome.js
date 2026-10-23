// First-run screen, shown while there are no tabs. Importing a backup must not create a tab first.
import { esc } from './render.js'

/**
 * @param {HTMLElement} root
 * @param {{onCreate(name: string): void, onImport(file: File): void}} cb
 */
export function renderWelcome(root, { onCreate, onImport }) {
  // Keep the typed name if the screen is redrawn (e.g. store notifications) while typing.
  const prev = root.querySelector('#firstTab')?.value ?? ''
  root.innerHTML = `<div class="welcome">
    <h1>Benvenuto in Andata e Ritorno</h1>
    <input type="text" id="firstTab" placeholder="Es. Nido di Sofia" aria-label="Come si chiama la prima scheda?" autocomplete="off" value="${esc(prev)}">
    <label for="firstTab" class="hint">Come si chiama la prima scheda?</label>
    <button class="primary" id="start" ${prev.trim() ? '' : 'disabled'}>Inizia</button>
    <button class="ghost" id="importBtn">Importa un backup</button>
    <input type="file" id="importFile" accept=".zip,application/zip,application/json,.json" hidden>
    <p class="note">I dati restano su questo telefono. Ricordati di fare un backup ogni tanto.</p>
  </div>`
  const $ = (id) => root.querySelector('#' + id)
  const input = $('firstTab'), start = $('start'), file = $('importFile')
  input.addEventListener('input', () => { start.disabled = !input.value.trim() })
  const create = () => { if (input.value.trim()) onCreate(input.value.trim()) }
  start.addEventListener('click', create)
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') create() })
  $('importBtn').addEventListener('click', () => file.click())
  file.addEventListener('change', () => {
    const f = file.files[0]; file.value = ''
    if (f) onImport(f)
  })
}
