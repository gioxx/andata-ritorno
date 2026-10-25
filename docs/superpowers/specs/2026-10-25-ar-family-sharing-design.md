# A/R — Family sharing (project 2) — design

Date: 2026-10-25 · Status: awaiting owner approval · Builds on: `2026-10-23-ar-v2-design.md`, `2026-10-25-ar-v2.2-design.md` (v2.6.0 is live at ar.gioxx.org)

## Intent

In a family, each parent or guardian has their own phone. One of them moves the children's clothes between home and school and keeps A/R up to date; when another does a drop-off or pick-up, their phone shows different (or no) data. Family sharing gives every phone in a family **the same wardrobe**, kept in step through a server.

It is the app's first **premium, donationware** feature: everything local stays free; sharing is unlocked by a one-off payment. The server must **never be able to read** a family's data: everything is encrypted on the phones.

This document also absorbs project 3 (payments): the only thing being paid for is this feature.

## Goals

1. Up to **4 devices per family** see and edit the same tabs, categories, items and photos.
2. Phones stay in step **when the app is opened** and **on demand** (pull-to-refresh on the main screen, "Sync" button in the menu). Real-time is not required.
3. **End-to-end encryption**: the server stores only ciphertext and the minimum metadata needed to route it.
4. **Unlock by payment**: 4,99 € unlocks sharing for a family (4 devices); 1,99 € adds one more device slot. Automatic delivery of the unlock code; manual codes as fallback (Ko-fi, Satispay, PayPal, complimentary codes).
5. An unlock code is **useless if posted online**: single-use, and devices join only by an invitation from a device already in the family.
6. **Changing phone never means paying again** (owner's requirement): what was paid for (the licence and any extra slots) survives losing or replacing every device.

## Non-goals

- Real-time updates while two people look at the app (nice-to-have, later; e.g. Durable Objects + WebSocket).
- One device in **several families** with a switcher (wanted later for guardians of children from different families; the data layout must not prevent it, see "Later").
- Accounts, passwords, email login.
- Key rotation when a device is removed.
- Per-item movement history.
- Native App Store / Play Store apps and in-app purchases (RevenueCat etc. were considered and rejected for a PWA).
- Deciding the tax/VAT treatment (owner's open item, see "Before going live").

## Anti-goals

- **The app blocks or slows down waiting for sync.** The app always opens instantly on local data; sync runs in the background and never holds the UI. Offline is a normal state, not an error.
- **The server (or the owner) can read names, categories, positions or photos.**
- **Users who never unlock sharing see any change in behaviour**: no network calls, no new prompts beyond the "Famiglia" section in the menu.
- Losing or corrupting any local item or photo when the database is upgraded, when joining a family (local data is merged, or replaced only by explicit choice after a ZIP backup is saved), or when leaving one.
- A published unlock code or invite link letting strangers into a family.

## Constraints

- Hosting: Cloudflare (same account), Worker + D1 + R2, custom domain `ar.gioxx.org`. Existing static-assets config: `worker/wrangler.app.toml`.
- One origin only (`ar.gioxx.org`): IndexedDB is per-origin.
- **iOS: Safari and the home-screen app have separate storage.** A link opened from the camera or a chat lands in Safari, not in the installed app. Every flow that ends with "paste/scan into the app" must work from inside the installed app.
- Code is AGPL-3.0 and public: the paywall lives on the server (codes are checked server-side), not in client code.
- UI in Italian and English (existing i18n). Code and comments in English.
- The merge rule already in the app (import) is the sync merge rule: per-field last-writer-wins. `location` follows the newer `movedAt`; `label`, `tabId`, `category` follow the newer `updatedAt`; tabs and categories merge by `id` with their own `updatedAt`. **One extension (my call):** `photoId` gets its own timestamp `photoAt` (set when a photo is added, replaced or rotated; falls back to `updatedAt` for older records and backups), so a concurrent label edit can never drag an item back to a photo that was already replaced. Import uses the same extended rule.

## Decided with the owner

- Sync on open + manual (pull-to-refresh and a menu "Sync" button). No real-time now.
- Free = everything local. Sharing unlocked by donation; receive an unlock code to enter in the app.
- Max 4 devices (two parents + two guardians); an extra slot is bought separately.
- Prices: **4,99 €** unlock, **1,99 €** extra slot.
- Payment provider: **Stripe Managed Payments** (Stripe is merchant of record: VAT and receipts are on Stripe; Italy is a supported seller country). Fallback by hand: Ko-fi / Satispay / PayPal.
- End-to-end encryption: the server must read nothing.
- Joining with existing local data: the user chooses on the join screen between **"Unisci i miei capi"** (merge, same rule as import; duplicate tabs/items possible, fixed by hand) and **"Usa il guardaroba di famiglia"** (a ZIP backup of local data is saved first, then local data is removed and the family's is downloaded).
- **"Ho un invito"** also on the welcome screen, so an empty phone joins without first creating a tab.
- One family per device for now.
- Sync status on the main screen: **a line of text at the bottom** ("Aggiornato 2 min fa · 3 modifiche da <nome dispositivo>"), mockup option B.
- Menu gains a **"Famiglia"** section (locked / active states as in the mockups); invite screen with QR + expiry; join screen with device name and a note that local items will be merged.

## How it works

### Overview

```
Phone A ──┐                    ┌── D1: families, devices, codes, invites, records (ciphertext)
Phone B ──┼── HTTPS /api/* ── Worker
Phone C ──┘                    └── R2: photos (ciphertext)
Stripe Checkout ── webhook ──▶ Worker ──▶ email with unlock code
```

The API is served by the **same Worker and origin** as the app (`ar.gioxx.org/api/*`, Worker runs first for `/api/*`, static assets for everything else) (my call: no CORS, one deploy). The old skeleton in `worker/src`, `worker/schema.sql` and `worker/wrangler.toml` is replaced or removed: it was never deployed (its D1 id is still a placeholder; README and v2 spec confirm), so D1 database and R2 bucket are created fresh and nothing live is at risk.

### Identity and access

- No accounts. Each device gets a random **device token** (≥ 256 bits) when it creates or joins a family. The server stores only its SHA-256 hash. Every API call sends `Authorization: Bearer <token>`.
- A device belongs to exactly one family. The server checks the token, finds the family, and serves only that family's data.
- Any device in the family can see the device list, invite, and remove any other device (my call: family members trust each other). Removing a device revokes its token immediately; its slot becomes free (changing phone costs nothing).

### Encryption

- The first device generates a random 256-bit **family key** (Web Crypto). The key never reaches the server.
- Every record and photo is encrypted with **AES-GCM**, fresh random 96-bit IV per encryption, with the family id and record id as additional authenticated data (so the server cannot swap blobs between records undetected).
- Encrypted too: family name, device names, tombstones, the record kind (item / tab / category).
- Visible to the server: random ids (family, device, record, photo), server sequence numbers, sizes, timestamps of uploads, device count, which device uploaded what.
- The key is stored on the device in IndexedDB (raw, so it can be put into invites) (my call: a compromised phone exposes the data anyway).
- **Accepted risk:** if every device of a family is lost, the server copy cannot be recovered. Local ZIP backups (existing feature) remain the safety net; the "Famiglia" section reminds this once at unlock.

### Unlock and payment

1. Menu → "Famiglia" (locked) → "Condivisione famiglia 4,99 €" opens a **Stripe Payment Link** (Managed Payments enabled, product tax code SaaS personal use) in the browser.
2. On success Stripe redirects to `https://ar.gioxx.org/unlock?session_id={CHECKOUT_SESSION_ID}`. That page asks the Worker for the code; the Worker verifies the Checkout Session with the Stripe API (paid, right product) and returns the code, with "Copia" and the instruction to paste it in the app (on iOS this page opens in Safari, not in the installed app — the copy must say so).
3. In parallel the `checkout.session.completed` **webhook** creates the same code and emails it to the payer (`customer_details.email`) via Cloudflare Email Service from a `gioxx.org` address.
4. Both paths are **idempotent on the Checkout Session id**: one payment = one code, however many times the page reloads or the webhook retries.
5. In the app: "Ho già un codice" → paste → choose family name and this device's name → the server marks the code redeemed, creates the family (limit 4 devices) and this device. The app generates the family key and uploads all local data.
6. **Extra slot (1,99 €)**: same flow with a second Payment Link; the code is a "slot" code, redeemable only by a device already in a family; it raises that family's limit by 1. A family code entered inside a family, or a slot code outside one, is refused with a clear message.

Codes: random, human-typable (e.g. `AR-XXXX-XXXX-XXXX`, Crockford base32, ≥ 60 bits), stored hashed, single-use, kind `family` or `slot`. Redeem attempts are rate-limited per IP.

**Manual codes** (Ko-fi, Satispay, PayPal, complimentary): a script in `worker/` generates a code of a given kind, stores its hash in D1, and prints it for the owner to send by hand (my call: a script run with the owner's Wrangler login rather than a public admin endpoint, so there is no admin secret on the internet).

### Licence and phone changes (owner's requirement: paying once is enough)

What a payment buys is a **licence**, kept on the server separately from the family it currently powers: kind, base device limit (4), extra slots bought, the hash of the code that created it, and an HMAC (server secret) of the payer's email when paid through Stripe. Extra-slot codes add to the licence, not to a family, so they survive any recovery. Three ways to get a new phone in, from the most common:

1. **Another family device is still around** (normal case): invite the new phone, remove the old one from "Dispositivi". Data and slots carry over. Nothing to pay.
2. **Recovery kit** (every device lost or changed together, data wanted back): at unlock the app shows a **recovery kit**, a code and QR holding family id, family key and a recovery secret (server keeps only the secret's hash), with "Salva" / "Copia" and a note to keep it somewhere safe; it is reachable again any time in Menu → Famiglia → "Kit di recupero". The kit is also included in ZIP backups made while in a family (backups are already unencrypted, so this adds no new exposure; the backup copy says so). On a new phone, "Ripristina famiglia" (welcome screen and menu) accepts the kit (paste, scan, or picked up automatically when importing such a ZIP): the server checks the secret and adds the device; if the family is full, the screen lists the devices so one can be removed first. The key comes from the kit, so all data comes back.
3. **Licence recovery** (kit lost too; data on the server is then unreadable, but the licence is not lost): "Recupera licenza" asks for the email used to pay; the Worker sends a one-time link (valid 30 minutes) to that address only if it matches a licence. Opening it on the new phone starts a **fresh family on the same licence** (same limit and extra slots), revokes all old devices and deletes the old family's unreadable records and photos, after an explicit confirmation that explains this. The response never reveals whether an email matched. Re-entering the original unlock code is **not** a recovery path (a code posted online could otherwise be used to take a family over). Licences from manual codes (Ko-fi, Satispay, PayPal, no email on file) are recovered by the owner by hand: the code script can re-issue a recovery for an existing licence.

### Invite and join

1. A device in the family: "Invita un telefono" → the Worker creates an **invite token** (single-use, expires in **10 minutes**, refused if the family is full). The screen shows a QR and "Condividi link", plus the countdown and "posto N di M".
2. The link is `https://ar.gioxx.org/join#<invite token>.<family id>.<family key>`. Everything after `#` is never sent to a server by browsers. The screen warns: the link contains the family key, send it only to who must join.
3. The new device opens the join screen in one of three ways: scanning the QR / opening the link (works directly on Android, where browser and installed app share storage); in-app **"Ho un invito"** → paste the link; or in-app QR scan where the browser supports it (builder's call on library). On iOS, if the link opens in Safari while the app is installed, the page says to open the installed app and offers "Copia invito" to paste there.
4. Join screen: family name (decrypted with the key from the link), field for this device's name, button "Entra". If the phone has local items, it also shows "Questo telefono ha N capi locali" and two choices: **"Unisci i miei capi"** (default) or **"Usa il guardaroba di famiglia"**. The second runs the existing backup export first (share sheet / download, same as menu → Esporta backup) and continues only once the export succeeded; then local tabs, categories, items and photos are removed. A phone with no items (only the tab the welcome screen would create, or nothing) joins without the choice. "Ho un invito" is reachable from the welcome screen as well as from the menu.
5. The Worker checks the token (valid, unused, not expired) and the device count against the limit **in one transaction**, creates the device, marks the invite used. The new device stores the key, downloads everything, merges with its local data (if the user chose to merge) and uploads the result.

### Sync

- **When**: app start, app back to foreground, pull-to-refresh on the main screen, "Sync" in the menu, and a debounced push a couple of seconds after local changes while online. Never blocks the UI; never runs for devices not in a family.
- **Records**: one encrypted record per tab, category and item. The plaintext carries the full object as in the local model plus `updatedBy` (device id) for the status line. Photos are separate encrypted objects in R2 (`<familyId>/<photoId>`); an item record references its `photoId`.
- **Pull**: `GET` changes since the device's last cursor (server sequence number), paged. The device decrypts and merges each record with the existing rule. If the merged result differs from what the server holds (the other side had older fields), the device marks it to push back, so all devices converge.
- **Push**: changed records are kept in a local **outbox** (new IndexedDB store, additive schema upgrade) and uploaded in batches; the server stores the ciphertext and assigns a new sequence number. A photo is uploaded **before** the item that references it.
- **Photos on a new device**: items appear as soon as their records arrive; photos download in the background, list stays usable with placeholders meanwhile (there are no thumbnails today; builder may add an encrypted thumbnail object if first-join download feels slow).
- **Deletions** (all my calls): deleting an item, tab or category writes an encrypted **tombstone** record with `deletedAt`; other devices apply it. Tombstones are kept (tiny).
  - Item: deletion wins over any concurrent edit dated before `deletedAt`. A later **re-creation** (newer `createdAt`/`updatedAt` than `deletedAt`) wins over the tombstone; this is what makes "add the default categories" work again for a deleted default (fixed ids).
  - **Import of a ZIP while in a family is an explicit restore**: an imported item or tab that is tombstoned is revived (stamped as re-created now) and syncs up. This is how an item deleted by mistake is recovered.
  - Tab: deleting it writes tombstones for the items the deleting device knows. An item that arrives later pointing at a tombstoned tab (added or moved there concurrently on another phone) is **never deleted**: it is moved to the first remaining tab and the status line mentions it ("1 capo spostato in <tab>").
  - Zero tabs: if merging leaves a family with no tabs (two phones deleted different last tabs), the device that notices creates one tab with the default name and puts any orphan items there. The local "can't delete the last tab" rule stays.
  - Category: deleting it does **not** rewrite items in sync (it would overwrite concurrent label edits through `updatedAt`). Every device simply shows an item whose category is tombstoned or unknown as uncategorised; the stale id is cleared the next time the item is edited for another reason.
- **Photo cleanup** (my call): a photo object becomes an orphan when its item is deleted or its photo replaced. Orphans are deleted from R2 only after **30 days**, by any device that has fully synced and finds no record referencing them; until then they can still be resolved by a late merge.
- **Clocks**: last-writer-wins uses device clocks (accepted; same as import today).
- **Import of a ZIP backup while in a family**: merges locally as today, then the changes sync up. Import still does not propagate deletions.
- **Status line** (main screen bottom, only when in a family): "Aggiornato 2 min fa", plus "· N modifiche da <device name>" after a pull that brought changes from others; "Sincronizzazione…" while running; "Offline · N modifiche da inviare" when offline with a non-empty outbox. Tapping it triggers a sync (my call).

### Menu "Famiglia"

- **Locked**: "Condivisione famiglia" + short description + "4,99 €"; "Ho già un codice"; "Ho un invito"; "Ripristina famiglia" / "Recupera licenza".
- **Active**: family name + last sync + "Sync"; "Dispositivi N / M" (list with names, "questo" marked, remove action); "Invita un telefono"; "Aggiungi un posto 1,99 €"; "Esci dalla famiglia".
- **Kit di recupero**: shows the recovery kit again (see "Licence and phone changes").
- **Leave family**: revokes this device's token and removes the family key from the device. Local data stays on the phone as a normal local wardrobe (my call). If it was the **last** device, the server deletes the family's records and photos; the **licence stays**, so licence recovery later starts a new family without paying.
- **"Delete all data"** (existing) on a device in a family: also leaves the family as above; it never deletes the family's server data while other devices remain.

### Abuse limits

Per family (my call, to keep the encrypted store from becoming free file hosting): max photo object 3 MB, max 2 000 photos, max 10 000 records, max request rates per device. Exceeding them returns a clear error; the app shows it in the status line.

### Security notes

- Stripe secret key and webhook signing secret as Wrangler secrets; webhook signature verified.
- The README warning about `/api/*` having no authentication no longer applies once device tokens exist; update it.
- The README "Privacy" section and the in-app copy that say "nothing on the server" become true only for the free tier; update them together with the privacy policy.
- CSP stays strict: same-origin API; Stripe is reached by navigation, not embedded.

## Before going live (owner)

- **Tax/VAT and how to present "donazione"**: owner checks with an accountant. Until then the payment buttons can stay hidden behind a switch while manual codes already work (my call: lets sharing be used and tested with manual codes before payments open).
- Stripe Managed Payments eligibility review passed; test mode end-to-end.
- **Privacy policy** (owner's request; a page in the app and on the site, Italian and English), needed because the app is public and premium data lives on the server. It must cover at least: free tier stores everything only on the device; premium stores encrypted data (records, photos) on Cloudflare D1/R2 that the owner cannot read, plus the metadata listed under "Encryption"; payer email used only to send the unlock code and, kept as a keyed hash, to recover the licence; Stripe is merchant of record and processes payment data; Cloudflare as hosting provider; retention and deletion (leaving the family, last device leaves = server data deleted); how to contact the owner. The builder **writes the policy text** (owner's standing practice; owner reviews it, Italian and English), adds the page and links it from the menu, the unlock flow and the payment page.

## Later (not in this project, but don't block it)

- **Several families per device** with a switcher: keep all sync state (family id, key, token, cursor, outbox) in one place keyed by family id, so a second family can later live in its own IndexedDB database (e.g. `ar-<familyId>`).
- **Real-time** push of changes.
- Automatic revocation on Stripe refunds/disputes (v1: none; refunds are rare and manual).
- Data retention for families inactive for a long time.

## Left to the builder

File/module structure, API routes and payload shapes, D1 schema details, paging sizes, debounce timing, QR generation and scanning libraries, Stripe SDK vs raw fetch + Web Crypto signature check, email template, exact copy (Italian and English) within the meaning given here, pull-to-refresh implementation in a standalone PWA, test strategy. Mandatory before release: two real devices (one Android, one iPhone installed PWA) join the same family, edit concurrently offline, reconnect, and end with identical data; and an upgrade of an existing device with real data loses nothing.

App version: 3.0.0 (my call).
