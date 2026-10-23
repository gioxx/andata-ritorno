# Andata e Ritorno (A/R)

Tiny PWA to track kids' clothes between home and school (nursery / kindergarten).
Each item has one state — **at school** or **at home** — and moves with a tap, instead of copying photos across four notes.

## Structure

```
legacy/          Frozen localStorage mockup (shows a "moved to ar.gioxx.org" banner)
app/             A/R v2 (in progress)
worker/          Cloudflare Worker API + D1 schema + R2 photos
```

## Try the mockup

```bash
npx serve legacy     # or: python3 -m http.server -d legacy
```

Open on a phone (same LAN) to test the camera flow. Data stays in the browser.

To share the mockup over HTTPS (installable PWA), deploy the static files only:

```bash
cd worker && npm install && npm run deploy:mockup
```

Target device for the mockup: Android (Chrome). iOS comes later.

## Deploy (Cloudflare free tier)

```bash
cd worker
npm install
npx wrangler d1 create andata-ritorno          # paste the id into wrangler.toml
npx wrangler r2 bucket create andata-ritorno-photos
npm run db:init
npm run deploy
```

Then protect the Worker hostname with **Cloudflare Access** (Zero Trust → Applications), allowing only your email addresses.

## Roadmap

- [ ] Replace localStorage in `legacy/index.html` with calls to `/api/*`
- [ ] Multi-select move (done in mockup) wired to `POST /api/move`
- [x] PWA icons
- [ ] Per-item movement history view
- [ ] Tap a section's item counter to select all items in that section (quick "move everything")
- [ ] Optional counters/categories (body, pants, spare outfit…)

## API

| Method | Path | Body |
|---|---|---|
| GET | `/api/items?child=nido` | — |
| POST | `/api/items` | multipart: `photo`, `child`, `label` |
| POST | `/api/move` | `{ ids: [], location: "school" \| "home" }` |
| DELETE | `/api/items/:id` | — |
| GET | `/api/photo/:key` | — |
