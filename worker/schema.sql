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
CREATE INDEX invites_family ON invites(family_id);
CREATE TABLE licence_links (hash TEXT PRIMARY KEY, licence_id TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT);
CREATE TABLE records (family_id TEXT NOT NULL, rid TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY (family_id, rid));
CREATE INDEX records_seq ON records(family_id, seq);
CREATE TABLE photos (family_id TEXT NOT NULL, pid TEXT NOT NULL, size INTEGER NOT NULL, uploaded_at TEXT NOT NULL,
  PRIMARY KEY (family_id, pid));
