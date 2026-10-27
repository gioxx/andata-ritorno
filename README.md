# Andata e Ritorno (A/R)

A small installable web app to keep track of kids' clothes between **home** and **school** (nursery, kindergarten…).
Take a photo of each item once; from then on every item is either *a scuola* or *a casa* and moves with a tap — no more copying photos between notes to remember what is where.

**Use it:** <https://ar.gioxx.org> — open it on your phone and add it to the home screen. The UI is available in Italian and English (automatic, with a switch in the menu).

## Features

- **Your own tabs**: one per child or per school (e.g. "Nido", "Materna"); add, rename, reorder or delete them.
- **Two places only**, school and home: tap items to select them (or tap a section's counter to select all), then move them in one go.
- **Photos** from the camera, the gallery or the clipboard, resized to 1600 px; full-screen viewer with pinch-to-zoom.
- **Rotate photos** with a single button; the rotation is saved when you confirm.
- **Edit** an item's description, tab, category or photo.
- **Categories**: optionally give each item one category (defaults: Bodysuits, Tops, Trousers, Dresses, Sweatshirts & jackets, Pyjamas, Underwear, Socks, Accessories); defaults are offered on request and can be edited. Filter with tags (OR logic, "All ✕" clears them).
- **Italian and English**, chosen automatically, switchable from the menu.
- **Accessible**: keyboard navigation, screen reader labels and good contrast.
- **iPhone support** and a readable navigation bar on Android.
- **Backup / restore** as a single `.zip` file (photos included, with integrity checks). Every backup is read back and verified before it is saved. Importing merges by item, so restoring the same backup twice creates no duplicates.
- **Works offline** and installs like an app (PWA).
- Light, dark or automatic theme.
- **App menu**: an *Install app* button (native prompt where the browser offers it, steps otherwise), *How to uninstall* instructions, and *Delete all data* (two steps, with an optional backup first and a typed confirmation).
- Security headers on the served app.

## Installing on iPhone

Open <https://ar.gioxx.org> in Safari, tap **Share → Add to Home Screen**. Install it: if you only use it in a Safari tab, Safari may delete the site's data after about 7 days without use. Export backups regularly anyway.

## Privacy

Everything stays on your device, in the browser's storage (IndexedDB). There is no account and no server-side storage: the site only serves the app's static files. The flip side is that **backups are your responsibility** — the app reminds you when there are changes you haven't exported yet.

## Development

```bash
cd app
npm install
npm run dev      # local dev server
npm test         # unit tests (Vitest)
npm run build    # production build in app/dist
```

Plain JavaScript (ES modules) with Vite, [idb](https://github.com/jakearchibald/idb), [fflate](https://github.com/101arrowz/fflate), [Lucide](https://lucide.dev) icons and the Plus Jakarta Sans font (self-hosted). Target devices: Android (Chrome) and iPhone (Safari).

## Deploy

The app is served as static assets by a Cloudflare Worker on a custom domain:

```bash
cd worker
npm install
npm run deploy:app   # builds app/ and publishes it (see worker/wrangler.app.toml)
```

Change the `routes` pattern in `worker/wrangler.app.toml` to deploy it on your own domain.

## Project structure

```
app/       the app (src/, tests/, public/ icons and manifest)
worker/    the Cloudflare Worker: app hosting and the `/api/*` family sharing API
legacy/    the first single-file prototype, kept only as reference for its backup format
docs/      design notes and the implementation plan
```

Backups exported from the old prototype (`andata-ritorno-AAAA-MM-GG.json`) can still be imported with "Importa un backup".

## Roadmap

- [x] Configurable tabs
- [x] Local storage in IndexedDB, ZIP backups
- [x] Full-screen photo viewer, item editing
- [x] Offline, installable PWA
- [x] Optional categories and a quick filter
- [x] Photo rotation, Italian/English, iPhone support
- [ ] Per-item movement history
- [ ] Family sharing between phones
- [ ] Privacy policy (public app, premium data on the server)

## Worker and API deploy notes

`worker/` holds the Cloudflare Worker that serves the app (static assets) and the family sharing API under `/api/*` (D1 + R2). One-time setup, in this order:

```bash
cd worker && npm install
npx wrangler d1 create andata-ritorno            # paste the id into wrangler.app.toml (database_id)
npx wrangler r2 bucket create andata-ritorno-photos
npm run db:init                                  # applies schema.sql to the remote database
# Secrets (interactive prompt; never commit values):
npx wrangler secret put STRIPE_SECRET_KEY --config wrangler.app.toml
npx wrangler secret put STRIPE_WEBHOOK_SECRET --config wrangler.app.toml
npx wrangler secret put EMAIL_HMAC_KEY --config wrangler.app.toml
npx wrangler secret put CODE_HMAC_KEY --config wrangler.app.toml
npx wrangler secret put RESEND_API_KEY --config wrangler.app.toml
npm run deploy:app
```

Also set `PRICE_FAMILY` and `PRICE_SLOT` (Stripe price ids) in `[vars]`. The `RL_STRICT` / `RL_API` rate-limit bindings are optional: without them the API simply does not rate-limit. Tests: `npm --prefix worker test`.

## In italiano

**Andata e Ritorno (A/R)** è una piccola app installabile per tenere traccia dei vestiti dei bambini tra **casa** e **scuola**: fotografi ogni capo una volta, poi con un tocco lo sposti *a scuola* o *a casa*. Novità della 2.2: rotazione foto, categorie con filtri, italiano/inglese, accessibilità, supporto iPhone, backup verificati.

**Usala:** <https://ar.gioxx.org>

- **Android**: apri il sito in Chrome e scegli "Installa app" / "Aggiungi a schermata Home".
- **iPhone**: apri il sito in Safari, tocca **Condividi → Aggiungi alla schermata Home**. Installala: se la usi solo in una scheda di Safari, dopo circa 7 giorni senza uso Safari può cancellare i dati.
- **Menu App**: *Installa app*, *Come disinstallare* ed *Elimina tutti i dati* (con backup facoltativo e conferma scritta).
- **Privacy**: tutto resta sul tuo dispositivo (IndexedDB), nessun account né archivio sul server.
- **Backup**: esporta un file `.zip` con le foto; ogni backup viene riletto e controllato prima del salvataggio. I backup sono una tua responsabilità.

## License

Copyright © 2026 Giovanni Solone. A/R is free software, released under the [GNU Affero General Public License v3.0](LICENSE): you may use, modify and redistribute it, and if you run a modified version as a network service you must make its source code available to its users under the same license.
