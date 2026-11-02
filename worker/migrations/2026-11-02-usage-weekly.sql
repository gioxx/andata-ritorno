-- Anonymous weekly usage counters (issue #35). Safe to run more than once.
-- Apply to every existing database before deploying the code that uses it:
--   npm run db:migrate -- --file=migrations/2026-11-02-usage-weekly.sql
-- (already applied to production `andata-ritorno` on 2026-11-02)
CREATE TABLE IF NOT EXISTS usage_weekly (week TEXT NOT NULL, metric TEXT NOT NULL, bucket TEXT NOT NULL, n INTEGER NOT NULL,
  PRIMARY KEY (week, metric, bucket));
