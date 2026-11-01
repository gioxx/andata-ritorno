# Andata e Ritorno (A/R)

*[Read in English](README.md)*

Una piccola web app installabile per tenere traccia dei vestiti dei bambini tra **casa** e **scuola** (nido, materna…).
Fotografi ogni capo una volta; da lì in poi ogni capo è *a scuola* o *a casa* e si sposta con un tocco. Basta foto copiate nelle note per ricordare cosa è dove.

**Usala:** <https://app.ar.gioxx.org> (presentazione e guida: <https://ar.gioxx.org>). Aprila sul telefono e aggiungila alla schermata Home. L'interfaccia è in italiano e in inglese (scelta automatica, con un selettore nel menu).

## Funzioni

- **Schede tue**: una per bambino o per scuola (per esempio "Nido", "Materna"); aggiungile, rinominale, riordinale o eliminale.
- **Solo due posti**, scuola e casa: tocca i capi per selezionarli (o il contatore di una sezione per prenderli tutti), poi spostali in un colpo solo.
- **Foto** dalla fotocamera, dalla galleria o dagli appunti, ridimensionate a 1600 px; visualizzatore a schermo intero con pinch-to-zoom.
- **Rotazione foto** con un solo pulsante; la rotazione viene salvata quando confermi.
- **Modifica** descrizione, scheda, categoria o foto di un capo.
- **Categorie**: a ogni capo puoi dare una categoria, se vuoi (predefinite: Body, Maglie, Pantaloni, Vestiti, Felpe e giacche, Pigiami, Intimo, Calze, Accessori); le predefinite si aggiungono su richiesta e si possono modificare. Filtri a etichette (logica OR, "Tutti ✕" li azzera).
- **Italiano e inglese**, scelti in automatico, modificabili dal menu.
- **Accessibile**: navigazione da tastiera, etichette per lettori di schermo e buon contrasto.
- **Supporto iPhone** e barra di navigazione leggibile su Android.
- **Backup e ripristino** in un unico file `.zip` (foto comprese, con controlli di integrità). Ogni backup viene riletto e verificato prima di essere salvato. L'importazione unisce capo per capo, quindi ripristinare due volte lo stesso backup non crea doppioni.
- **Funziona offline** e si installa come un'app (PWA).
- Tema chiaro, scuro o automatico.
- **Menu App**: pulsante *Installa app* (prompt nativo dove il browser lo offre, istruzioni altrimenti), istruzioni *Come disinstallare* ed *Elimina tutti i dati* (in due passaggi, con backup facoltativo prima e conferma scritta).
- **Condivisione in famiglia** (facoltativa, a pagamento): lo stesso guardaroba sincronizzato su tre telefoni (di più con posti aggiuntivi), cifrato end-to-end (vedi Privacy). Senza condivisione l'app non parla mai con un server.
- Header di sicurezza sull'app servita.

## Installazione su iPhone

Apri <https://app.ar.gioxx.org> in Safari, tocca **Condividi → Aggiungi alla schermata Home**. Installala: se la usi solo in una scheda di Safari, dopo circa 7 giorni senza uso Safari può cancellare i dati del sito. Esporta comunque un backup ogni tanto.

## Privacy

**Uso gratuito:** tutto resta sul tuo dispositivo, nello spazio del browser (IndexedDB). Non c'è nessun account e nulla viene inviato a un server: il sito serve solo i file statici dell'app. Il rovescio della medaglia è che **i backup sono una tua responsabilità**: l'app ti avvisa quando ci sono modifiche non ancora esportate.

**Condivisione in famiglia** (facoltativa): capi, schede, categorie, foto e nomi vengono cifrati sul telefono (AES-GCM) con una chiave che non lascia mai i dispositivi della famiglia, poi salvati su Cloudflare (D1 e R2). Il server non può leggerli; vede solo identificativi casuali, dimensioni, orari di caricamento delle foto, il numero di dispositivi e quando ciascuno è stato attivo l'ultima volta. L'email di chi paga serve a inviare il codice di sblocco e, come hash con chiave (HMAC), a recuperare la licenza. Stripe (pagamenti), Resend (email) e Cloudflare (hosting) sono i responsabili del trattamento. Informativa completa, in italiano e in inglese: [`app/public/privacy.html`](app/public/privacy.html), pubblicata su <https://app.ar.gioxx.org/privacy.html> e raggiungibile dal menu dell'app.

## Sviluppo

```bash
cd app
npm install
npm run dev      # server di sviluppo locale
npm test         # test unitari (Vitest)
npm run build    # build di produzione in app/dist
```

JavaScript puro (moduli ES) con Vite, [idb](https://github.com/jakearchibald/idb), [fflate](https://github.com/101arrowz/fflate), icone [Lucide](https://lucide.dev) e il font Plus Jakarta Sans (ospitato in locale). Dispositivi di riferimento: Android (Chrome) e iPhone (Safari).

## Pubblicazione

L'app è servita come asset statici da un Cloudflare Worker su un dominio personalizzato:

```bash
cd worker
npm install
npm run deploy:app   # compila app/ e la pubblica (vedi worker/wrangler.app.toml)
```

Cambia il pattern `routes` in `worker/wrangler.app.toml` per pubblicarla su un tuo dominio.

## Struttura del progetto

```
app/       l'app (src/, tests/, public/ icone e manifest)
worker/    il Cloudflare Worker: hosting dell'app e API `/api/*` della condivisione in famiglia
landing/   pagina di presentazione e guida su ar.gioxx.org (statica, con un suo Worker: `cd landing && npx wrangler deploy`)
legacy/    il primo prototipo in un solo file, tenuto solo come riferimento per il suo formato di backup
docs/      note di progetto e piano di implementazione
```

I backup esportati dal vecchio prototipo (`andata-ritorno-AAAA-MM-GG.json`) si possono ancora importare con "Importa un backup".

## Roadmap

- [x] Schede configurabili
- [x] Archivio locale in IndexedDB, backup ZIP
- [x] Visualizzatore foto a schermo intero, modifica dei capi
- [x] PWA installabile e offline
- [x] Categorie facoltative e filtro rapido
- [x] Rotazione foto, italiano/inglese, supporto iPhone
- [x] Condivisione in famiglia tra telefoni
- [x] Informativa privacy (app pubblica, dati premium sul server)
- [x] Sito di presentazione <https://ar.gioxx.org> (pagina prodotto e guida, in italiano e in inglese)

## Note di pubblicazione del Worker e dell'API

`worker/` contiene il Cloudflare Worker che serve l'app (asset statici) e l'API della condivisione in famiglia sotto `/api/*` (D1 + R2). Configurazione iniziale, una volta sola, in quest'ordine:

```bash
cd worker && npm install
npx wrangler d1 create andata-ritorno            # incolla l'id in wrangler.app.toml (database_id)
npx wrangler r2 bucket create andata-ritorno-photos
npm run db:init                                  # applica schema.sql al database remoto
# Secret (prompt interattivo; non committare mai i valori):
npx wrangler secret put STRIPE_SECRET_KEY --config wrangler.app.toml
npx wrangler secret put STRIPE_WEBHOOK_SECRET --config wrangler.app.toml
npx wrangler secret put EMAIL_HMAC_KEY --config wrangler.app.toml
npx wrangler secret put CODE_HMAC_KEY --config wrangler.app.toml
npx wrangler secret put RESEND_API_KEY --config wrangler.app.toml
npm run deploy:app
```

Poi:

1. **Resend**: il dominio `ar.gioxx.org` deve essere verificato in Resend (record DNS); le email con il codice di sblocco e il recupero licenza partono da `noreply@ar.gioxx.org`.
2. **Stripe**: attiva Managed Payments, poi crea due Payment Link, ciascuno con un solo prezzo e quantità fissa a 1: lo sblocco famiglia (4,99 €) e il posto dispositivo aggiuntivo (1,99 €). Su entrambi imposta come URL di successo `https://app.ar.gioxx.org/unlock?session_id={CHECKOUT_SESSION_ID}`.
3. **Webhook Stripe**: aggiungi un endpoint `https://app.ar.gioxx.org/api/stripe/webhook` in ascolto su `checkout.session.completed` e `checkout.session.async_payment_succeeded`; il suo signing secret è `STRIPE_WEBHOOK_SECRET`.
4. Metti i due price id di Stripe in `PRICE_FAMILY` e `PRICE_SLOT` in `[vars]` di `wrangler.app.toml`.
5. **Ambiente di build** dell'app (letto da Vite durante `npm run deploy:app`, per esempio dalla shell o da `app/.env.production`, da non committare se preferisci): `VITE_PAYMENTS=1` mostra i pulsanti d'acquisto (lascialo vuoto per nasconderli: i codici manuali funzionano comunque), `VITE_STRIPE_LINK_FAMILY` e `VITE_STRIPE_LINK_SLOT` sono gli URL dei due Payment Link.
6. **Tetto allo spazio foto**: `MAX_TOTAL_PHOTO_BYTES` in `[vars]` di `wrangler.app.toml` (9 000 000 000 se non impostato) è il massimo di byte di foto che il server conserva sommando tutte le famiglie, per restare nei 10 GB gratuiti di R2. Oltre, le nuove foto ricevono `413 limit-storage` (i capi continuano a sincronizzarsi, le foto esistenti restano leggibili); eliminare foto o una famiglia libera spazio. Il totale corrente sta nella tabella `usage` (riga `photo_bytes`), creata e inizializzata da `schema.sql`. Le righe delle foto hanno un flag `ready`: la riga viene scritta (non pronta, nascosta da elenco e lettura) quando i byte vengono riservati e diventa pronta quando l'oggetto R2 esiste, così un caricamento interrotto viene semplicemente rimandato dalla sincronizzazione successiva. Il totale conta tutte le righe, pronte o no.

   Un database creato prima della tabella `usage` e della colonna `ready` richiede, una volta: `ALTER TABLE photos ADD COLUMN ready INTEGER NOT NULL DEFAULT 1; CREATE TABLE usage (key TEXT PRIMARY KEY, bytes INTEGER NOT NULL); INSERT INTO usage (key, bytes) SELECT 'photo_bytes', COALESCE(SUM(size), 0) FROM photos;`. Se il totale si disallinea (per esempio dopo una pulizia manuale), riallinealo con `UPDATE usage SET bytes = (SELECT COALESCE(SUM(size), 0) FROM photos) WHERE key = 'photo_bytes';` (tutte le righe, pronte o no).
7. **Codici manuali** (Ko-fi, Satispay, PayPal, regali), da lanciare con il tuo login Wrangler dalla radice del repository: `node worker/scripts/code.mjs family --remote` (o `slot`); `node worker/scripts/code.mjs recover <codice> --remote` stampa un link di recupero per una licenza senza email registrata.

I binding di rate limit `RL_STRICT` / `RL_API` sono facoltativi: senza, l'API semplicemente non limita le richieste. Non committare mai valori segreti. Test: `npm --prefix worker test`.

## Licenza

Copyright © 2026 Giovanni Solone. A/R è software libero, distribuito con la [GNU Affero General Public License v3.0](LICENSE): puoi usarlo, modificarlo e ridistribuirlo, e se offri una versione modificata come servizio di rete devi renderne disponibile il codice sorgente ai suoi utenti con la stessa licenza.
