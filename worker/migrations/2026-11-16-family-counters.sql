-- Family size counters and the queue of photo purges to retry.
-- Family size counters, so a push no longer scans every record of the family (security review M1).
-- Apply to every existing database BEFORE deploying the code that uses it:
--   npm run db:migrate -- --file=migrations/2026-11-16-family-counters.sql
-- Not idempotent: ALTER TABLE fails if the columns already exist (then skip it).
ALTER TABLE families ADD COLUMN records_n INTEGER NOT NULL DEFAULT 0;
ALTER TABLE families ADD COLUMN data_bytes INTEGER NOT NULL DEFAULT 0;
UPDATE families SET
  records_n = (SELECT COUNT(*) FROM records WHERE family_id = families.id),
  data_bytes = (SELECT COALESCE(SUM(length(data)), 0) FROM records WHERE family_id = families.id);
CREATE TABLE IF NOT EXISTS pending_purges (family_id TEXT PRIMARY KEY, since TEXT NOT NULL);
