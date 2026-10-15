-- D1 schema for Andata e Ritorno (A/R) items
CREATE TABLE IF NOT EXISTS items (
  id         TEXT PRIMARY KEY,
  child      TEXT NOT NULL CHECK (child IN ('nido', 'materna')),
  location   TEXT NOT NULL CHECK (location IN ('school', 'home')),
  label      TEXT NOT NULL DEFAULT '',
  photo_key  TEXT NOT NULL,            -- R2 object key
  moved_at   TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_items_child_location ON items (child, location);

-- Optional movement history
CREATE TABLE IF NOT EXISTS moves (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id   TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  location  TEXT NOT NULL,
  moved_at  TEXT NOT NULL,
  moved_by  TEXT
);
