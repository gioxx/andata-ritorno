# Andata e Ritorno (A/R)

Tiny PWA to track kids' clothes between home and school (nursery / kindergarten).
Each item has one state — **at school** or **at home** — and moves with a tap, instead of copying photos across four notes.

## Structure

```
legacy/          Frozen localStorage mockup (shows a "moved to ar.gioxx.org" banner)
app/             A/R v2: Vite + plain JS, IndexedDB, ZIP backup (deployed to ar.gioxx.org)
worker/          Wrangler configs (app, mockup) + old API Worker / D1 schema (not deployed in v2)
```

## Develop (v2)

```bash
cd app && npm install && npm run dev
npm test
```

## Deploy (Cloudflare Workers, static assets)

```bash
cd worker && npm install
npm run deploy:app       # builds app/ and publishes to https://ar.gioxx.org
npm run deploy:mockup    # publishes legacy/ (the old mockup)
```

The old API Worker (`npm run deploy`, D1 + R2) is not used by v2.

## Migrazione dal mockup

1. Nel mockup tocca "Esporta backup" e salva il file.
2. Apri ar.gioxx.org.
3. Tocca "Importa un backup" e scegli il file.
4. Confronta i numeri del riepilogo con quelli del mockup.
5. Non cancellare nulla dal mockup finché non hai controllato.

## Try the old mockup

```bash
npx serve legacy     # or: python3 -m http.server -d legacy
```

## Roadmap

- [x] Configurable tabs
- [x] IndexedDB storage (replaces localStorage)
- [x] Item viewer
- [x] ZIP backup / restore
- [x] Select all via section counter
- [x] PWA icons, manifest and offline cache
- [ ] Optional counters/categories (body, pants, spare outfit...)
- [ ] Per-item movement history view
- [ ] Family sharing
- [ ] Payments

## API

| Method | Path | Body |
|---|---|---|
| GET | `/api/items?child=nido` | — |
| POST | `/api/items` | multipart: `photo`, `child`, `label` |
| POST | `/api/move` | `{ ids: [], location: "school" \| "home" }` |
| DELETE | `/api/items/:id` | — |
| GET | `/api/photo/:key` | — |
