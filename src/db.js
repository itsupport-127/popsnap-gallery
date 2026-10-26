const { DatabaseSync } = require("node:sqlite");
const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, "gallery.db"));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS buckets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  region TEXT NOT NULL DEFAULT 'auto',
  bucket TEXT NOT NULL,
  access_key TEXT NOT NULL,
  secret_key TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 10,
  quota_bytes INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  studio TEXT NOT NULL,
  studio_code TEXT,
  mode TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_file_at INTEGER
);
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL,
  fid TEXT NOT NULL,
  kind TEXT NOT NULL,
  idx INTEGER NOT NULL DEFAULT 0,
  ext TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  bucket_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  uploaded_at INTEGER,
  UNIQUE(token, fid)
);
CREATE INDEX IF NOT EXISTS idx_files_token ON files(token);

CREATE INDEX IF NOT EXISTS idx_files_bucket ON files(bucket_id);
CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions(expires_at);
`);

try { db.exec("ALTER TABLE sessions ADD COLUMN manual INTEGER NOT NULL DEFAULT 0"); } catch { /* sudah ada */ }

const getSetting = (k, def) => { const r = db.prepare("SELECT v FROM settings WHERE k = ?").get(k); return r ? r.v : def; };
const setSetting = (k, v) => db.prepare("INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, String(v));
const retentionDays = () => Math.max(1, Math.min(365, Number(getSetting("retention_days", process.env.RETENTION_DAYS || 7)) || 7));

module.exports = { db, getSetting, setSetting, retentionDays, DATA_DIR };
