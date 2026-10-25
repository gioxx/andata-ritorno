# Andata e Ritorno (A/R)

Tiny PWA to track kids' clothes between home and school (nursery / kindergarten).
Each item has one state — **at school** or **at home** — and moves with a tap, instead of copying photos across four notes.

## Structure

```
legacy/          Old localStorage mockup (offline since 2026-10-25; kept as reference for the v1 backup format)
app/             A/R v2: Vite + plain JS, IndexedDB, ZIP backup (deployed to ar.gioxx.org)
worker/          Wrangler config for the app + old API Worker / D1 schema (not deployed in v2)
```

## Develop (v2)

```bash
cd app && npm install && npm run dev
npm test
```

Target device: Android (Chrome). iOS comes later.

## Deploy (Cloudflare Workers, static assets)

```bash
cd worker && npm install
npm run deploy:app       # builds app/ and publishes to https://ar.gioxx.org
```

The old API Worker (`npm run deploy`, D1 + R2) is not used by v2.

## Backup del vecchio mockup

Il mockup non è più online. Un file `andata-ritorno-AAAA-MM-GG.json` esportato dal mockup si può ancora importare in ar.gioxx.org con "Importa un backup".

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

## Old API Worker (not deployed in v2 — reference for project 2)

`worker/src` + `worker/schema.sql` (D1 + R2). v2 does not use it. If it is ever deployed, set it up in this order:

```bash
cd worker && npm install
npx wrangler d1 create andata-ritorno          # paste the id into wrangler.toml
npx wrangler r2 bucket create andata-ritorno-photos
npm run db:init
npm run deploy
```

**Protect it with Cloudflare Access before any deploy** (Zero Trust → Applications, only your email addresses): `/api/*` has no auth of its own.
