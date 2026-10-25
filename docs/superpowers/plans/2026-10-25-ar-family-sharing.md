# A/R Family Sharing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship A/R 3.0.0: up to 4 devices per family share one end-to-end encrypted wardrobe, synced on open and on demand, unlocked by a one-off payment (Stripe Managed Payments) or a manual code, with a licence that survives phone changes.

**Architecture:** The `ar.gioxx.org` Worker gains an API under `/api/*` (D1 for licences, families, devices, invites and encrypted records; R2 for encrypted photos). The app gets a `sync/` layer: Web Crypto AES-GCM codec, a pure merge of remote records into local state, an IndexedDB outbox and tombstones written in the same transactions as local edits, and an engine that pulls then pushes in the background. UI adds a "Famiglia" menu section, a status line, join/invite/recovery flows and a few path-routed pages (`/unlock`, `/join`, `/licence`).

**Tech Stack:** App: Vite, plain JS, idb, fflate, lucide, Vitest (+ fake-indexeddb, jsdom), `uqr` (QR SVG generation, new dependency). Worker: Wrangler 4, D1, R2, Workers Rate Limiting binding, Resend HTTP API for email (owner's decision: Cloudflare outbound email needs Workers Paid), raw `fetch` to the Stripe API with Web Crypto webhook verification (no Stripe SDK), Vitest + `@cloudflare/vitest-pool-workers`.

**Spec:** `docs/superpowers/specs/2026-10-25-ar-family-sharing-design.md` (builds on the v2 and v2.2 specs in the same folder)

## Global Constraints

- Devices not in a family make **zero** network requests and see no change except the "Famiglia" menu section and the two welcome-screen buttons.
- Sync never blocks the UI: the app renders local data first; every network call runs after render, in the background.
- The server never receives plaintext family data, the family key, or the recovery secret. Visible to the server: random ids, sequence numbers, sizes, upload times, device count, uploader device.
- Crypto: AES-GCM 256, fresh random 12-byte IV per encryption, ciphertext layout `iv || ct`, AAD = UTF-8 of `${familyId}:${recordId}` (records), `${familyId}:photo:${photoId}` (photos), `${familyId}:family-name`, `${familyId}:device:${deviceId}`.
- Tokens: device token, invite token, recovery secret, licence-link token = 32 random bytes, base64url; server stores only SHA-256 hex of each.
- Unlock codes: `AR-XXXX-XXXX-XXXX`, Crockford base32 (alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`), 12 random symbols (60 bits); input normalised (uppercase, strip spaces/dashes, `O→0`, `I/L→1`) before hashing.
- Limits: base device limit 4; invite TTL 10 min; licence link TTL 30 min; photo object ≤ 3 MB; ≤ 2 000 photos and ≤ 10 000 records per family; orphan photos deleted after 30 days unreferenced.
- Prices and links: 4,99 € family unlock, 1,99 € extra slot; Payment Link URLs from `VITE_STRIPE_LINK_FAMILY` / `VITE_STRIPE_LINK_SLOT`; payment buttons shown only when `VITE_PAYMENTS === '1'` (manual codes always work).
- Merge rule: per-field LWW; `location`←`movedAt`, `label`/`tabId`/`category`←`updatedAt`, `photoId`←`photoAt ?? updatedAt`; tabs/categories by own `updatedAt`. Ties keep the local side.
- Never lose local data: IndexedDB upgrade v2→v3 is additive; joining merges unless the user chose "Usa il guardaroba di famiglia" **and** the backup export succeeded; leaving keeps local data.
- Every user-visible string in `app/src/i18n/it.js` and `en.js` (same key set). Code and comments in English.
- **No personal references** in any committed file (no family members, no real data counts, no real names except the existing author/copyright lines). Example names in copy/tests: generic ("Telefono 1", "Famiglia Rossi" only in tests).
- App version `3.0.0` in `app/package.json`.

## Review Focus

1. A device that stayed offline for days with edits reconnects after others edited and deleted the same items → no edit newer than a deletion is lost, all devices end identical — test in Task 9.
2. Upgrading a real v2 database (tabs, categories, items, photos, meta) to v3 → every record and blob unchanged, outbox empty, sync disabled — test in Task 2.
3. A removed device (server answers 401) → keeps working locally, status line says it is no longer in the family, sync stops, no retry loop — test in Task 9.
4. The `/unlock` page reloaded and the Stripe webhook retried for the same session → exactly one code — test in Task 6.
5. Two phones redeem invites for the last free slot at the same time → one joins, the other gets `family-full` — test in Task 7.

---

## File Structure

```
worker/
  wrangler.app.toml        + main, D1, R2, ratelimits, assets.run_worker_first=["/api/*"]
  schema.sql               replaced (tables below)
  src/index.js             replaced: router; non-/api requests fall through to env.ASSETS
  src/http.js              json(), error(code,status), readJson(), b64url helpers
  src/auth.js              sha256Hex(), randomToken(), deviceFromRequest(env, req) → {deviceId, familyId}
  src/codes.js             newCode(), normaliseCode(), hashCode()
  src/licence.js           redeem/slot/stripe session/webhook/licence recovery routes
  src/stripe.js            verifyWebhook(), getCheckoutSession()
  src/email.js             sendCodeEmail(), sendLicenceLinkEmail()
  src/family.js            family info, invites, join, devices, leave/purge, recovery kit routes
  src/sync.js              pull/push records
  src/photos.js            photo PUT/GET/DELETE/list
  scripts/code.mjs         manual codes and licence recovery links (runs wrangler d1 execute)
  test/*.test.js           pool-workers tests
  vitest.config.js
  (deleted) wrangler.toml, old src files
app/src/
  sync/crypto.js           generateKey, importKey, encrypt, decrypt, encryptJson, decryptJson, b64url
  sync/records.js          encodeRecord, decodeRecord, tombstone shapes
  sync/merge.js            mergeRemote(local, remote) → SyncPlan (pure)
  sync/api.js              createApi({fetch, token}) → typed calls (one function per route)
  sync/engine.js           syncNow(), status store, triggers, photo download queue, orphan cleanup
  sync/family.js           family meta (get/set/clear), redeem/join/leave/recover orchestration
  ui/syncLine.js           bottom status line + pull-to-refresh
  ui/familyMenu.js         "Famiglia" menu section rows and actions
  ui/familyDialogs.js      code entry, devices, invite QR, kit, licence recovery, join screen
  ui/pages.js              /unlock, /join, /licence standalone pages
  routes.js                routeOf(pathname, hash)
app/public/privacy.html    bilingual privacy policy (static)
```
Modified: `app/src/db.js`, `store.js`, `backup/merge.js`, `backup/zip.js`, `backup/importer.js`, `types.js`, `ui/filter.js`, `ui/render.js`, `ui/menu.js`, `ui/welcome.js`, `ui/wipeFlow.js`, `main.js`, `i18n/*.js`, `app/public/_headers`, `app/package.json`, `worker/package.json`, `README.md`.

### Shared API contract (Tasks 5–9 and 9–12 use exactly this)

All bodies JSON unless noted; binary fields are base64url strings; errors are `{ error: '<code>' }` with the status shown. Auth = `Authorization: Bearer <deviceToken>`; missing/unknown/revoked token → 401 `unauthorized`.

| Method & path | Auth | Request | Response |
|---|---|---|---|
| POST `/api/redeem` | – | `{code, familyId, deviceId, familyNameEnc, deviceNameEnc, recoveryHash}` | `{token, deviceLimit}`; 404 `bad-code`, 409 `code-used`, 409 `code-is-slot`, 429 `rate-limited` |
| POST `/api/slot` | ✓ | `{code}` | `{deviceLimit}`; 404 `bad-code`, 409 `code-used`, 409 `code-is-family` |
| GET `/api/unlock/session?id=cs_…` | – | | `{code, kind}`; 402 `not-paid`, 404 `bad-session` |
| POST `/api/stripe/webhook` | Stripe sig | raw body | 200 |
| GET `/api/family` | ✓ | | `{familyId, familyNameEnc, deviceLimit, you, devices:[{id, nameEnc, createdAt, lastSeenAt}]}` |
| POST `/api/invites` | ✓ | | `{token, expiresAt, used, limit}`; 409 `family-full` |
| GET `/api/invites/info?t=` | – | | `{familyNameEnc, used, limit}`; 410 `invite-expired` |
| POST `/api/join` | – | `{inviteToken, deviceId, deviceNameEnc}` | `{token, deviceLimit}`; 410 `invite-expired`, 409 `family-full` |
| DELETE `/api/devices/:id` | ✓ | | `{purged:boolean}` (self allowed = leave; last device → purge family data) |
| POST `/api/recover` | – | `{familyId, recoverySecret, deviceId, deviceNameEnc}` | `{token, deviceLimit}`; 403 `bad-kit`, 409 `family-full` + `{devices}` |
| POST `/api/recover/remove-device` | – | `{familyId, recoverySecret, deviceId}` | `{ok:true}`; 403 `bad-kit` |
| POST `/api/licence/email` | – | `{email}` | 202 always |
| POST `/api/licence/restart` | – | `{linkToken, familyId, deviceId, familyNameEnc, deviceNameEnc, recoveryHash}` | `{token, deviceLimit}`; 410 `link-expired` |
| GET `/api/sync?since=N` | ✓ | | `{records:[{rid, seq, data}], next, more}` (≤ 500 per page) |
| POST `/api/sync` | ✓ | `{records:[{rid, data}]}` (≤ 200) | `{seq}`; 413 `limit-records` |
| PUT `/api/photos/:pid` | ✓ | binary body (ciphertext) | 204; 413 `limit-photo-size`, 413 `limit-photos` |
| GET `/api/photos/:pid` | ✓ | | binary; 404 |
| GET `/api/photos` | ✓ | | `{photos:[{pid, size, uploadedAt}]}` |
| DELETE `/api/photos/:pid` | ✓ | | 204 |

Every successful authed call updates `devices.last_seen_at`.

---

### Task 1: `photoAt` and a shared item merge

**Files:**
- Modify: `app/src/backup/merge.js`, `app/src/db.js` (`addItems` callers via `store.js`, `replacePhoto`), `app/src/store.js` (`addPhotos`, `rotateAndEdit`), `app/src/backup/zip.js` (`normItem`), `app/src/types.js`
- Test: `app/tests/merge.test.js`, `app/tests/db.test.js`, `app/tests/zip.test.js`

**Interfaces:**
- Produces: `export function mergeItem(a: Item, b: Item): Item` in `backup/merge.js` (ties keep `a`); `Item.photoAt?: string`.

- [ ] **Step 1: Write failing tests**
  - `merge.test.js` › `photoId follows photoAt, not updatedAt`: local `{photoId:'p2', photoAt:'T2', label:'a', updatedAt:'T2'}`, incoming `{photoId:'p1', photoAt:'T1', label:'b', updatedAt:'T3'}` → merged `photoId === 'p2'`, `label === 'b'`.
  - › `missing photoAt falls back to updatedAt` (both sides without `photoAt`, newer `updatedAt` wins the photo).
  - `db.test.js` › `replacePhoto sets photoAt = now`.
  - `zip.test.js` › `normItem keeps a valid photoAt and drops an invalid one`.
- [ ] **Step 2:** Run `npm --prefix app test -- merge db zip` → the new tests fail.
- [ ] **Step 3: Implement.** Export `mergeItem`; pick the photo side with `(x.photoAt ?? x.updatedAt)`; copy `photoAt` from the winner (omit when absent). `replacePhoto` and `rotateAndEdit` set `photoAt: now`; `addPhotos` sets `photoAt = createdAt`. `normItem` keeps `photoAt` only if ISO. Add `photoAt` to `FIELDS` in `merge.js`.
- [ ] **Step 4:** Run `npm --prefix app test` → all pass.
- [ ] **Step 5:** Commit `Give item photos their own merge timestamp`.

### Task 2: IndexedDB v3 — outbox, tombstones, wardrobe clear

**Files:**
- Modify: `app/src/db.js`, `app/src/types.js`
- Test: `app/tests/db.test.js`

**Interfaces:**
- Produces (all in `db.js`):
  - `setSyncTracking(on: boolean): void` — module flag; when true every write below also records outbox entries in the **same transaction**.
  - Outbox store `outbox`, key `${kind}:${id}`, value `{kind:'item'|'tab'|'category', id}`; tombstone store `tombstones`, keyPath `id`, value `{kind, id, deletedAt}`.
  - `readOutbox(db): Promise<{kind,id}[]>`, `clearOutbox(db, keys: string[]): Promise<void>`, `getTombstones(db): Promise<Map<string, Tombstone>>`, `putTombstones(db, list)`, `clearSyncStores(db)` (outbox + tombstones), `clearWardrobe(db)` (tabs, categories, items, photos, outbox, tombstones; keeps meta except `unsavedCount`→0).
  - `applySyncPlan(db, plan: SyncPlan)` — one transaction over tabs, categories, items, photos, tombstones, outbox (see Task 4 for `SyncPlan`).
- Types: `Tombstone = {kind, id, deletedAt}`.

- [ ] **Step 1: Write failing tests**
  - `upgrade v2 → v3 keeps every record byte-identical` (seed a v2 DB with 2 tabs, 2 categories, 3 items, 3 photo blobs, meta keys; reopen with v3; deep-equal everything; blobs compared by bytes; `outbox` and `tombstones` exist and are empty).
  - `with tracking off, writes add no outbox entries`.
  - `with tracking on`: `moveItems` → outbox has `item:<id>`; `deleteItems` → tombstone `{kind:'item', id, deletedAt: now}` + outbox entry, same tx (inject a failing put and check neither is written); `deleteTab` → tombstones for tab and each of its items; `deleteCategory` → tombstone for the category and **no item rewrite** when tracking is on (items keep `category` and `updatedAt`).
  - `clearWardrobe empties data stores, keeps meta`.
  - `applyPlan (import) with tracking on`: every put gets an outbox entry; an imported tab or item whose id has a tombstone is **revived** (tombstone removed, `updatedAt = now` so it beats the tombstone on other devices) — the spec's "import while in a family is an explicit restore".
- [ ] **Step 2:** Run → fail.
- [ ] **Step 3: Implement.** `openDB(name, 3, …)` with `if (oldVersion < 3)` creating the two stores. `deleteTab`/`deleteItems`/`deleteCategory`/all puts take a `now` where needed (add the parameter to `deleteTab` and `deleteItems`, and `applyPlan(db, plan, now = new Date().toISOString())`; update callers). With tracking off, `deleteCategory` keeps today's behaviour.
- [ ] **Step 4:** Run `npm --prefix app test` → pass.
- [ ] **Step 5:** Commit `Add sync outbox and tombstones to the local database`.

### Task 3: Crypto and record codec

**Files:**
- Create: `app/src/sync/crypto.js`, `app/src/sync/records.js`
- Test: `app/tests/syncCrypto.test.js`

**Interfaces:**
- `crypto.js`: `generateKeyRaw(): Uint8Array` (32 bytes); `importKey(raw: Uint8Array): Promise<CryptoKey>`; `encrypt(key, aad: string, bytes: Uint8Array): Promise<Uint8Array>`; `decrypt(key, aad, data): Promise<Uint8Array>` (throws `decrypt-failed`); `encryptJson(key, aad, obj): Promise<string /*b64url*/>`; `decryptJson(key, aad, b64): Promise<any>`; `b64url.encode(u8)`, `b64url.decode(str)`; `randomToken(): string`; `sha256Hex(str): Promise<string>`.
- `records.js`: `recordAad(familyId, rid)`; `encodeRecord(key, familyId, {kind, value, by}) → Promise<{rid, data}>` where `rid = value.id`; `encodeTombstone(key, familyId, {kind, id, deletedAt, by})`; `decodeRecord(key, familyId, {rid, seq, data}) → Promise<{rid, seq, kind, value?, tombstone?: Tombstone, by}>`.
  Plaintext shape: `{k: kind, v: value}` or `{k: kind, dead: {id, deletedAt}}`, plus `by` (device id).

- [ ] **Step 1: Write failing tests:** round-trip item/tab/category/tombstone; same plaintext twice → different ciphertext; swapping `data` between two rids → `decrypt-failed`; wrong key → `decrypt-failed`; `b64url` round-trip of all byte values.
- [ ] **Step 2:** Run `npm --prefix app test -- syncCrypto` → fail.
- [ ] **Step 3:** Implement with `crypto.subtle` (Node test runtime has it).
- [ ] **Step 4:** Run → pass.
- [ ] **Step 5:** Commit `Add end-to-end encryption codec for sync records`.

### Task 4: Pure sync merge

**Files:**
- Create: `app/src/sync/merge.js`
- Modify: `app/src/ui/filter.js`, `app/src/ui/render.js` (uncategorised display), `app/src/types.js`
- Test: `app/tests/syncMerge.test.js`, `app/tests/filter.test.js`

**Interfaces:**
- Consumes: `mergeItem` (Task 1).
- Produces: `mergeRemote(local: {tabs, categories, items, tombstones: Map}, remote: DecodedRecord[], {now, defaultTabName}) → SyncPlan`:
  ```
  SyncPlan = { tabsPut, tabsDelete, categoriesPut, categoriesDelete, itemsPut, itemsDelete,
               photosDelete /*local blobs no longer referenced*/, tombstonesPut, pushBack /*{kind,id}[]*/,
               photosNeeded /*photoIds referenced but not local*/, movedOrphans /*number*/, changesBy /*Map deviceId→count*/ }
  ```
- Produces in `filter.js`: `effectiveCategory(item, knownIds: Set<string>): string|undefined`; `visibleItems`/`usableFilters` take `knownIds` and treat unknown ids as uncategorised.

Rules (from the spec, all must have a test):
- Remote value vs local: items via `mergeItem(local, remote)`; tabs/categories newer `updatedAt` wins. If the merged result differs from the **remote** value → `pushBack`.
- Remote tombstone vs local record: delete when `deletedAt >` the record's newest timestamp (`max(updatedAt, movedAt, photoAt)` for items, `updatedAt` for tabs/categories); otherwise keep local and `pushBack` it (re-creation wins).
- Remote value vs local tombstone: same comparison the other way (value newer than `deletedAt` → put it and drop the tombstone).
- Items whose `tabId` is tombstoned or unknown after the merge → moved to the first remaining tab by `order` (`tabId` change with `updatedAt = now`, pushed back), counted in `movedOrphans`.
- No tabs left after the merge → create one tab `{name: defaultTabName}` with a new UUID, put orphan items in it, push it.
- Category tombstones never rewrite items.
- `changesBy`: count of remote records applied, per `by`, excluding this device.

- [ ] **Step 1: Write failing tests** — one per rule above, plus `idempotent: applying the same remote batch twice yields an empty plan the second time`, plus `filter.test.js` › `an item with a deleted category counts as uncategorised`.
- [ ] **Step 2:** Run → fail.
- [ ] **Step 3:** Implement (pure, no I/O, no Date access except `now` param).
- [ ] **Step 4:** Run → pass.
- [ ] **Step 5:** Commit `Add pure merge of synced records into local state`.

### Task 5: Worker foundation

**Files:**
- Modify: `worker/wrangler.app.toml`, `worker/package.json`, `worker/schema.sql`, `worker/src/index.js`
- Create: `worker/src/http.js`, `worker/src/auth.js`, `worker/vitest.config.js`, `worker/test/auth.test.js`
- Delete: `worker/wrangler.toml`, any other old files in `worker/src`
- Modify: `README.md` (remove "Unused API Worker" section; deploy notes for D1/R2/secrets)

**Interfaces:**
- `auth.js`: `sha256Hex(s): Promise<string>`, `randomToken(): string`, `requireDevice(env, req): Promise<{deviceId, familyId}>` (throws `HttpError(401,'unauthorized')`, touches `last_seen_at`).
- `http.js`: `class HttpError(status, code, extra?)`, `json(obj, status=200)`, `readJson(req, maxBytes=65536)`, `route(req, table)`.
- Config: bindings `DB` (D1 `andata-ritorno`), `PHOTOS` (R2 `andata-ritorno-photos`), `RL_STRICT` (ratelimit 10/60s), `RL_API` (ratelimit 120/60s); vars `APP_ORIGIN="https://ar.gioxx.org"`, `PRICE_FAMILY`, `PRICE_SLOT` (Stripe price ids); secrets `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `EMAIL_HMAC_KEY`, `CODE_HMAC_KEY`, `RESEND_API_KEY`. If the account refuses the ratelimit bindings on the free plan, the code must work without them (`env.RL_*` absent → no limiting; tokens/codes have enough entropy). `assets.run_worker_first = ["/api/*"]`, keep `not_found_handling = "single-page-application"`. Scripts: `test`, `db:init` (`--remote --file=schema.sql`), `db:init:local`, `deploy:app` (unchanged command).
- Schema (exact):
  ```sql
  CREATE TABLE licences (id TEXT PRIMARY KEY, base_limit INTEGER NOT NULL DEFAULT 4, extra_slots INTEGER NOT NULL DEFAULT 0,
    email_hmac TEXT, family_id TEXT, created_at TEXT NOT NULL);
  CREATE INDEX licences_email ON licences(email_hmac);
  CREATE TABLE codes (hash TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('family','slot')), source TEXT NOT NULL,
    stripe_session TEXT UNIQUE, email_hmac TEXT, created_at TEXT NOT NULL, redeemed_at TEXT, licence_id TEXT);
  CREATE TABLE families (id TEXT PRIMARY KEY, licence_id TEXT NOT NULL, name_enc TEXT NOT NULL, recovery_hash TEXT NOT NULL,
    seq INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
  CREATE TABLE devices (id TEXT PRIMARY KEY, family_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, name_enc TEXT NOT NULL,
    created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL);
  CREATE INDEX devices_family ON devices(family_id);
  CREATE TABLE invites (hash TEXT PRIMARY KEY, family_id TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT);
  CREATE TABLE licence_links (hash TEXT PRIMARY KEY, licence_id TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT);
  CREATE TABLE records (family_id TEXT NOT NULL, rid TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL,
    PRIMARY KEY (family_id, rid));
  CREATE INDEX records_seq ON records(family_id, seq);
  CREATE TABLE photos (family_id TEXT NOT NULL, pid TEXT NOT NULL, size INTEGER NOT NULL, uploaded_at TEXT NOT NULL,
    PRIMARY KEY (family_id, pid));
  ```
- [ ] **Step 1:** Read the `wrangler` and `workers-best-practices` skills; set up `@cloudflare/vitest-pool-workers` with a version compatible with the chosen Vitest, D1 migrations applied from `schema.sql` in test setup.
- [ ] **Step 2: Failing tests** (`auth.test.js`): non-`/api` path is served by assets (`env.ASSETS.fetch` called); `/api/unknown` → 404 `not-found`; authed route with no/invalid token → 401; valid token → passes and updates `last_seen_at`.
- [ ] **Step 3:** Run `npm --prefix worker test` → fail. Implement. Run → pass.
- [ ] **Step 4:** `npx wrangler deploy --dry-run --config wrangler.app.toml` succeeds.
- [ ] **Step 5:** Commit `Replace the unused API skeleton with the family sharing Worker base`.

### Task 6: Codes, licences, Stripe and manual codes

**Files:**
- Create: `worker/src/codes.js`, `worker/src/licence.js`, `worker/src/stripe.js`, `worker/src/email.js`, `worker/scripts/code.mjs`, `worker/test/licence.test.js`
- Modify: `worker/src/index.js`

**Interfaces:**
- `codes.js`: `newCode(): string`, `normaliseCode(input): string|null`, `hashCode(code): Promise<string>`.
- `stripe.js`: `verifyWebhook(rawBody: string, sigHeader: string, secret: string, nowSec: number): Promise<object>` (v1 HMAC-SHA256, tolerance 300 s, throws 400 `bad-signature`); `getCheckoutSession(env, id): Promise<{id, payment_status, customer_details:{email}, line_items:[{price:{id}}]}>` (expand `line_items`).
- `licence.js` routes: `/api/redeem`, `/api/slot`, `/api/unlock/session`, `/api/stripe/webhook`, `/api/licence/email`, `/api/licence/restart`; internal `issueCodeForSession(env, session): Promise<{code, kind}>` — idempotent on `codes.stripe_session`: if a row exists, return its code. Since only the hash is stored, the plaintext code for a session is derived deterministically: `code = codeFromHmac(STRIPE_WEBHOOK_SECRET, session.id)` (same Crockford format), so page and webhook produce the same code without storing it.
- Redeem: in one D1 `batch`: mark code redeemed (`WHERE redeemed_at IS NULL`), create licence (`email_hmac` copied from the code row), family (`seq 0`), device. Slot: code kind `slot`, add 1 to the caller family's licence `extra_slots`.
- Licence email: `HMAC-SHA256(EMAIL_HMAC_KEY, lowercase(trim(email)))`; if a licence matches, create link token (30 min) and email `${APP_ORIGIN}/licence#${token}`; respond 202 regardless.
- Licence restart: valid link → in one batch: delete old family's records, photos rows, devices, invites, family row; create new family + device on the same licence; mark link used; then delete R2 objects with prefix `${oldFamilyId}/`.
- `email.js`: plain-text Italian + English emails via `POST https://api.resend.com/emails` (`Authorization: Bearer ${RESEND_API_KEY}`), sender `A/R <noreply@ar.gioxx.org>`; a failed send is logged and never fails the webhook/request (the code is also on the /unlock page).
- `scripts/code.mjs`: `node scripts/code.mjs family|slot [--remote]` → prints a new code, inserts its hash with `source='manual'`; `node scripts/code.mjs recover <code> [--remote]` → finds the licence through the code hash, creates a licence link, prints the URL. Uses `npx wrangler d1 execute andata-ritorno --command …` with the code generated locally.

- [ ] **Step 1: Failing tests:** redeem happy path returns token + limit 4 and makes the code unusable (`code-used` on second try); lowercase/space/O-for-0 input still redeems; slot code via `/api/redeem` → `code-is-slot`; slot raises limit to 5; webhook with bad signature → 400; webhook + `/api/unlock/session` for the same paid session (fetch to Stripe mocked) called 3 times in any order → one `codes` row, same code every time (**Review Focus 4**); unpaid session → 402; price id decides kind; licence email for unknown address → 202 and no email sent; known address → one email with a link; restart purges the old family and keeps `extra_slots`; redeem rate limit returns 429.
- [ ] **Step 2:** Run → fail. Implement. Run → pass.
- [ ] **Step 3:** Run `node worker/scripts/code.mjs family` against `--local` D1 and redeem the printed code through `wrangler dev` with curl → 200.
- [ ] **Step 4:** Commit `Add unlock codes, Stripe checkout handling and licence recovery`.

### Task 7: Family, invites, devices, recovery kit

**Files:**
- Create: `worker/src/family.js`, `worker/test/family.test.js`
- Modify: `worker/src/index.js`

**Interfaces:** routes `/api/family`, `/api/invites`, `/api/invites/info`, `/api/join`, `/api/devices/:id`, `/api/recover`, `/api/recover/remove-device` as in the contract. Device limit = `base_limit + extra_slots` of the family's licence. Join and recover insert the device with a conditional insert (`INSERT … SELECT … WHERE (SELECT COUNT(*) FROM devices WHERE family_id=?) < ?`) and check `changes`, so the count check and insert are atomic. Leaving/removing the last device purges the family (records, photos rows, invites, family row, R2 prefix) but **keeps the licence** (`licences.family_id = NULL`).

- [ ] **Step 1: Failing tests:** invite → info → join happy path; invite used twice → second `invite-expired`; invite after 10 min (inject clock) → `invite-expired`; invite when full → `family-full`; two concurrent joins for the last slot → exactly one 200 and one 409 (**Review Focus 5**); removing another device revokes its token (its next call 401) and frees the slot; self-delete of the last device → `{purged:true}`, records/photos gone, licence row still there; recover with right secret adds device; wrong secret → 403; recover when full → 409 with device list; remove-device with kit then recover → 200.
- [ ] **Step 2:** Run → fail. Implement. Run → pass.
- [ ] **Step 3:** Commit `Add family invites, devices and recovery kit to the Worker`.

### Task 8: Sync and photo storage

**Files:**
- Create: `worker/src/sync.js`, `worker/src/photos.js`, `worker/test/sync.test.js`
- Modify: `worker/src/index.js`

**Interfaces:** routes as in the contract. Push: one D1 batch increments `families.seq` by the number of records and upserts each record with its new seq (`ON CONFLICT(family_id, rid) DO UPDATE SET data=excluded.data, seq=excluded.seq`). Pull: `WHERE family_id=? AND seq>? ORDER BY seq LIMIT 500`, `next` = last seq, `more` = page full. Photos: R2 key `${familyId}/${pid}`, size checked from `Content-Length` and actual body (≤ 3 MB), count ≤ 2 000, records ≤ 10 000 (counted before insert). All sync/photo routes go through `RL_API` per device.

- [ ] **Step 1: Failing tests:** push 3 → pull since 0 returns 3 in seq order; push update of one rid → pull since previous cursor returns only it; paging with 501 records → `more:true`, second page 1; device of family A can't read B's records or photos (404/empty); photo over 3 MB → 413 `limit-photo-size`; 2 001st photo → 413 `limit-photos`; photo list and delete.
- [ ] **Step 2:** Run → fail. Implement. Run → pass.
- [ ] **Step 3:** Commit `Add encrypted record sync and photo storage to the Worker`.

### Task 9: App API client and sync engine

**Files:**
- Create: `app/src/sync/api.js`, `app/src/sync/engine.js`, `app/src/sync/family.js`, `app/tests/syncEngine.test.js`, `app/tests/helpers/fakeServer.js`
- Modify: `app/src/store.js` (expose `reloadFromDb()` used after a sync plan is applied; never during a queued mutation — run through `runExclusive`)

**Interfaces:**
- `api.js`: `createApi({fetchFn = fetch, getToken}) → { redeem, slot, unlockSession, family, createInvite, inviteInfo, join, removeDevice, recover, recoverRemoveDevice, licenceEmail, licenceRestart, pull, push, putPhoto, getPhoto, listPhotos, deletePhoto }`, one per contract row; non-2xx throws `ApiError {status, code, extra}`; network failure throws `ApiError {status:0, code:'offline'}`.
- `family.js` (meta key `family`): `getFamily(db): Promise<FamilyMeta|null>`, `setFamily(db, meta)`, `clearFamily(db)`; `FamilyMeta = {familyId, deviceId, token, keyRaw /*b64url*/, recoverySecret, cursor, lastSyncAt, licenceKind:'family'}`. Orchestration: `createFamily(db, api, {code, familyName, deviceName})`, `joinFamily(db, api, {inviteToken, familyId, keyRaw, deviceName, mode:'merge'|'replace'})`, `recoverFamily(db, api, kit, deviceName)`, `restartFromLicence(db, api, {linkToken, familyName, deviceName})`, `leaveFamily(db, api)`, `kitOf(meta) → string` (`ARKIT1.<familyId>.<keyB64>.<secretB64>`), `parseKit(str)`, `parseInvite(urlOrHash) → {inviteToken, familyId, keyRaw}`.
  Creating, joining or recovering ends with `setSyncTracking(true)` and every local tab/category/item put in the outbox (so local data uploads).
- `engine.js`: `initSync({db, api, onApplied})`, `syncNow(reason: 'start'|'visible'|'pull'|'menu'|'line'|'debounce'): Promise<void>` (single-flight; a call while running schedules one more run), `syncStatus` object `{state:'idle'|'syncing'|'offline'|'removed'|'error', lastSyncAt, pending, lastChanges:{count, by}, movedOrphans, errorCode}` with `subscribeSync(fn)`. Run order: pull all pages → decode (skip and log records that fail to decrypt) → `mergeRemote` → `applySyncPlan` → `onApplied()` → upload photos needed by outbox items (before their records) → push outbox in batches of 200 → `clearOutbox` for pushed keys → background photo download for `photosNeeded` (max 3 parallel; items without a local blob render a placeholder) → orphan cleanup (meta `orphanSeen: {pid: firstSeenAt}`; delete server photos unreferenced for 30 days).
  401 → state `removed`, `setSyncTracking(false)`, family meta kept with `removed:true` so the menu can explain; no further network calls until the user leaves or rejoins.
  Debounce: 2 s after a store notification when outbox is non-empty and state is not offline/removed.

- [ ] **Step 1: Write `fakeServer.js`** implementing the contract in memory (same semantics as Tasks 6–8, no crypto checks) with an injectable clock and an `offline` switch.
- [ ] **Step 2: Failing tests (two fake-indexeddb databases = two phones):**
  - create family on A with 3 items → B joins with `mode:'merge'` and its own 1 item → after `syncNow` on both, A and B have 4 identical items and photos.
  - B joins with `mode:'replace'` → B ends with A's 3 items only (export step is UI, not tested here).
  - **Review Focus 1:** both offline; A deletes item X and edits Y's label; B moves X and edits Y's location after A's deletion time; reconnect, sync A, B, A → X exists on both (B's move is newer than the deletion), Y has A's label and B's location; a second round produces no pushes.
  - **Review Focus 3:** server removes B; B's `syncNow` → status `removed`, no further fetch calls on later `syncNow`, local data intact.
  - offline → status `offline`, outbox kept, next online sync pushes it.
  - a record that fails to decrypt is skipped, others applied.
- [ ] **Step 3:** Run → fail. Implement. Run → pass.
- [ ] **Step 4:** Commit `Add sync engine and family orchestration to the app`.

### Task 10: Status line, pull-to-refresh and triggers

**Files:**
- Create: `app/src/ui/syncLine.js`, `app/tests/syncLine.test.js`
- Modify: `app/src/ui/render.js`, `app/src/main.js`, `app/src/styles.css`, `app/src/i18n/it.js`, `app/src/i18n/en.js`

**Interfaces:**
- `syncLineText(status, now, deviceNames: Map) → string` (pure), `renderSyncLine(): string`, `initPullToRefresh(scrollEl, onRefresh)`.
- Copy (it / en): `Aggiornato {ago}` / `Updated {ago}`; `· {n} modifiche da {name}` / `· {n} changes from {name}`; `Sincronizzazione…` / `Syncing…`; `Offline · {n} modifiche da inviare` / `Offline · {n} changes to send`; `{n} capo spostato in {tab}` (plural `{n} capi spostati in {tab}`) / `{n} item moved to {tab}` (`items`); `Questo telefono non è più nella famiglia` / `This phone is no longer in the family`. `{ago}` uses the existing relative-time wording from `ui/since.js` where possible.
- main.js: when `getFamily(db)` returns a family, after first render: `setSyncTracking(true)`, `initSync`, `syncNow('start')`; `visibilitychange` → visible → `syncNow('visible')`; the line is a button → `syncNow('line')`; pull-to-refresh on the main scroll area (threshold 70 px, only when scrolled to top, `overscroll-behavior-y: contain` on the container so the browser's own refresh doesn't fire).

- [ ] **Step 1: Failing tests:** `syncLineText` for each state; line not rendered when no family; `render.test.js` › line present at the bottom when a family exists.
- [ ] **Step 2:** Run → fail. Implement. Run → pass.
- [ ] **Step 3:** Commit `Show sync status and add pull-to-refresh`.

### Task 11: "Famiglia" menu, unlock, devices, invite, slot

**Files:**
- Create: `app/src/ui/familyMenu.js`, `app/src/ui/familyDialogs.js`, `app/tests/familyMenu.test.js`
- Modify: `app/src/ui/menu.js` (new section before "Backup"), `app/src/i18n/*.js`, `app/package.json` (add `uqr`), `app/src/styles.css`

**Interfaces:**
- `familyMenuHtml(state: {family: FamilyMeta|null, info?, payments: boolean}) → string` (pure); actions `unlock` (opens `VITE_STRIPE_LINK_FAMILY` in a new tab), `code`, `invite-have`, `restore`, `licence`, `sync`, `devices`, `invite`, `slot`, `kit`, `leave`.
- Locked rows: "Condivisione famiglia" + "Stesso guardaroba su più telefoni, cifrato" + pill `4,99 €` (only if payments on); "Ho già un codice"; "Ho un invito"; "Ripristina famiglia"; "Recupera licenza". Active rows: family name + "Ultima sync: {ago}" + "Sync"; "Dispositivi {n} / {m}"; "Invita un telefono"; "Aggiungi un posto" + `1,99 €` (payments on; else the row opens slot code entry); "Kit di recupero"; "Esci dalla famiglia" (danger). Removed state: explanation + "Esci dalla famiglia".
- Dialogs in `familyDialogs.js`: `openCodeDialog()` (code + family name + device name → `createFamily`; slot codes when in a family → `api.slot`); `openDevices()` (list, "questo" tag, remove with confirm); `openInvite()` (QR via `uqr` SVG of `${origin}/join#${token}.${familyId}.${keyB64}`, countdown to `expiresAt`, "Condividi link" via `navigator.share` else copy, warning "Il link contiene la chiave di famiglia: mandalo solo a chi deve entrare."); `openKit()` (kit text + QR + Copia/Salva as `.txt`, warning to keep it safe; shown automatically once right after `createFamily`); `openLeave()` (confirm; explains local data stays).
- Error codes → messages for every `ApiError.code` in the contract (it/en).

- [ ] **Step 1: Failing tests:** `familyMenuHtml` locked/active/removed, payments on/off (no price pills when off); devices count text; error code → message table covers every contract code (test iterates the list).
- [ ] **Step 2:** Run → fail. Implement. Run → pass.
- [ ] **Step 3:** Commit `Add the family section to the menu`.

### Task 12: Join, recovery, licence and payment pages

**Files:**
- Create: `app/src/routes.js`, `app/src/ui/pages.js`, `app/tests/routes.test.js`, `app/tests/join.test.js`
- Modify: `app/src/main.js`, `app/src/ui/welcome.js`, `app/src/ui/familyDialogs.js` (join screen), `app/src/backup/zip.js` + `app/src/backup/importer.js` (kit in backups), `app/src/ui/importFlow.js`, `app/src/ui/wipeFlow.js`, `app/public/_headers`, `app/src/i18n/*.js`

**Interfaces:**
- `routeOf(pathname, hash) → {page:'app'} | {page:'join', invite} | {page:'unlock', sessionId} | {page:'licence', linkToken}`.
- Join screen (`openJoin(invite)`): calls `inviteInfo`, decrypts family name, device-name field, button "Entra". If the device has items: text "Questo telefono ha {n} capi locali" and two choices, default **"Unisci i miei capi"**, other **"Usa il guardaroba di famiglia"** → runs `exportBackup`; continues only on `'shared'`, or on `'downloaded'` after the existing "did the download work?" confirmation; then `joinFamily(... mode:'replace')`. No items → no choice.
- `/join` page: on Android or in the installed app → app boots and opens the join screen. In iOS Safari non-standalone (`platform.js`): page says to open the installed app, button "Copia invito" (copies the full link); "Ho un invito" in the app accepts a pasted link via `parseInvite`.
- In-app QR scan: button shown only when `'BarcodeDetector' in window`; uses the rear camera; `_headers` `Permissions-Policy: camera=(self), microphone=(), geolocation=()`.
- Welcome screen: two more ghost buttons "Ho un invito" and "Ripristina famiglia" under "Importa backup".
- `/unlock?session_id=`: page calls `unlockSession`, shows the code large with "Copia", text: "Apri A/R e inseriscilo in Menu → Famiglia → Ho già un codice. Te l'abbiamo mandato anche per email." On iOS add "Se hai installato A/R, aprila dalla schermata Home: questa pagina è in Safari." Errors: not paid / bad session messages.
- `/licence#token`: same pattern: in the app, opens "Recupera licenza" step 2 (family name, device name, confirmation text: "Inizia una nuova famiglia con la tua licenza. I dati della vecchia famiglia sul server verranno cancellati: non si possono più leggere senza il kit di recupero."); in iOS Safari, "Copia link" to paste into the app.
- Backups: when in a family, `backup.json` gains `familyKit: "<kitOf(meta)>"`; the export dialog adds one line saying the backup contains the family key. Import: a file with `familyKit` on a device not in a family → after the normal import, offer "Ripristina famiglia" with the kit prefilled.
- Wipe flow: in a family, first `leaveFamily` (best effort; offline → continue, and the done text says to remove the phone from another device).

- [ ] **Step 1: Failing tests:** `routeOf` for each path; `parseInvite` accepts full URL and bare hash, rejects malformed; join with items shows the choice, without items doesn't; "replace" aborts when export returns `'cancelled'` (nothing cleared, not joined); backup with kit round-trips through `buildZip`/`parseZip`; importer exposes the kit.
- [ ] **Step 2:** Run → fail. Implement. Run → pass.
- [ ] **Step 3:** Commit `Add join, recovery, licence and unlock flows`.

### Task 13: Privacy policy, docs, version, release checks

**Files:**
- Create: `app/public/privacy.html`
- Modify: `app/src/ui/menu.js` (link "Privacy" in the App section), `app/src/ui/pages.js` and `familyDialogs.js` (link from unlock flow and `/unlock` page), `README.md` (Privacy section, roadmap ticks, deploy steps: D1 create, R2 create, `db:init`, secrets, Resend domain ar.gioxx.org (already verified by the owner), Stripe Payment Links with Managed Payments and success URL `https://ar.gioxx.org/unlock?session_id={CHECKOUT_SESSION_ID}`, webhook `checkout.session.completed` to `/api/stripe/webhook`), `app/package.json` (`3.0.0`), in-app copy that says nothing is stored on a server (now "free tier")
- Test: `app/tests/a11y.test.js` (new dialogs/pages labelled), `app/tests/i18n.test.js` (key parity covers new keys)

- [ ] **Step 1: Write `privacy.html`** (Italian first, English below, same CSS tokens as the app, light/dark, no scripts). Must state: free use keeps everything on the device; family sharing stores encrypted records and photos on Cloudflare (D1, R2, EU/US per Cloudflare), unreadable by the developer, and lists the visible metadata (random ids, sizes, times, device count, which device uploaded what); payer email used only to send the code and, as a keyed hash, to recover the licence; Stripe is merchant of record and processes payment data under its own policy; Cloudflare is the hosting provider; Resend sends the emails; retention: data deleted when the last device leaves or on licence restart, licence record kept to honour the purchase; rights (access/deletion) and contact address `privacy@gioxx.org` (owner to confirm the address before release); no tracking, no analytics, no ads. No personal references.
- [ ] **Step 2:** Link it; update README and copy; bump version.
- [ ] **Step 3:** Run `npm --prefix app test && npm --prefix worker test && npm --prefix app run build` → all green, build succeeds.
- [ ] **Step 4: Release rehearsal (manual, blocks release):** local `wrangler dev` with D1/R2 local; manual code → create family on desktop Chrome profile A; join from profile B (merge) and C (replace, export verified); concurrent offline edits on A and B, reconnect → identical; remove C from A → C shows "no longer in the family"; recovery kit restores on a fresh profile; Stripe test mode Payment Link → `/unlock` shows code, email received, webhook retry doesn't duplicate. Then the same two-device check on a real Android phone and a real iPhone installed PWA (owner). Upgrade an existing v2.6 profile with real data → nothing lost.
- [ ] **Step 5:** Commit `Add privacy policy and prepare A/R 3.0.0`.
