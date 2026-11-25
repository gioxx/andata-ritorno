-- Yearly licences: a licence and a family code may now have a term.
-- licences.expires_at NULL = never expires (every licence sold before this change).
-- codes.term NULL = lifetime code (every code issued before), 'year' = one year from redemption.
-- Apply to every existing database BEFORE deploying the code that uses it:
--   npm run db:migrate -- --file=migrations/2026-11-25-annual-licence.sql
-- Not idempotent: ALTER TABLE fails if the columns already exist (then skip it).
ALTER TABLE licences ADD COLUMN expires_at TEXT;
ALTER TABLE codes ADD COLUMN term TEXT CHECK (term IS NULL OR term = 'year');
CREATE INDEX licences_expires ON licences(expires_at);
