# Andata e Ritorno (A/R)

A small installable web app to keep track of kids' clothes between **home** and **school** (nursery, kindergarten…).
Take a photo of each item once; from then on every item is either *a scuola* or *a casa* and moves with a tap — no more copying photos between notes to remember what is where.

**Use it:** <https://ar.gioxx.org> — open it on your phone and add it to the home screen. The UI is in Italian.

## Features

- **Your own tabs**: one per child or per school (e.g. "Nido", "Materna"); add, rename, reorder or delete them.
- **Two places only**, school and home: tap items to select them (or tap a section's counter to select all), then move them in one go.
- **Photos** from the camera, the gallery or the clipboard, resized to 1600 px; full-screen viewer with pinch-to-zoom.
- **Edit** an item's description, tab or photo.
- **Backup / restore** as a single `.zip` file (photos included, with integrity checks). Importing merges by item, so restoring the same backup twice creates no duplicates.
- **Works offline** and installs like an app (PWA).
- Light, dark or automatic theme.

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

Plain JavaScript (ES modules) with Vite, [idb](https://github.com/jakearchibald/idb), [fflate](https://github.com/101arrowz/fflate), [Lucide](https://lucide.dev) icons and the Plus Jakarta Sans font (self-hosted). Target device: Android (Chrome); iOS comes later.

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
worker/    Cloudflare config for the app, plus an unused API Worker (see below)
legacy/    the first single-file prototype, kept only as reference for its backup format
docs/      design notes and the implementation plan
```

Backups exported from the old prototype (`andata-ritorno-AAAA-MM-GG.json`) can still be imported with "Importa un backup".

## Roadmap

- [x] Configurable tabs
- [x] Local storage in IndexedDB, ZIP backups
- [x] Full-screen photo viewer, item editing
- [x] Offline, installable PWA
- [ ] Optional categories (body, pants, spare outfit…) and a quick filter
- [ ] Per-item movement history
- [ ] Family sharing between phones

## Unused API Worker

`worker/src` and `worker/schema.sql` (D1 + R2) are an early skeleton for a future sync/sharing feature. The app does not use them and they are not deployed. `/api/*` has **no authentication of its own**: never deploy `worker/wrangler.toml` without putting Cloudflare Access (or equivalent) in front of it. Setup order, for reference:

```bash
cd worker && npm install
npx wrangler d1 create andata-ritorno          # paste the id into wrangler.toml
npx wrangler r2 bucket create andata-ritorno-photos
npm run db:init
npm run deploy
```
