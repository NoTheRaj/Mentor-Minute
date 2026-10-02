const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'mentorminute.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('seeker','guide')),
  balance REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS guide_profiles (
  user_id INTEGER PRIMARY KEY,
  company TEXT,
  domain TEXT,
  bio TEXT,
  rate_per_min REAL NOT NULL DEFAULT 10,
  is_online INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seeker_id INTEGER NOT NULL,
  guide_id INTEGER NOT NULL,
  rate REAL NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT,
  minutes INTEGER DEFAULT 0,
  amount REAL DEFAULT 0,
  status TEXT DEFAULT 'active',
  FOREIGN KEY (seeker_id) REFERENCES users(id),
  FOREIGN KEY (guide_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  sender_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  amount REAL NOT NULL,
  session_id INTEGER,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER UNIQUE NOT NULL,
  rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
  comment TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);
CREATE TABLE IF NOT EXISTS payments (
  order_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  amount REAL NOT NULL,
  status TEXT NOT NULL,
  payment_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
`);

module.exports = db;