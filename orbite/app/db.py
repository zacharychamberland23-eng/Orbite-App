"""Stockage SQLite d'Orbite (une connexion par fil d'execution, mode WAL)."""
import os
import sqlite3
import threading

DB_PATH = os.environ.get("ORBITE_DB", "/data/orbite.db")
_local = threading.local()

SCHEMA = """
CREATE TABLE IF NOT EXISTS connections (
  id INTEGER PRIMARY KEY,
  proto TEXT, ip TEXT, rport INTEGER, lport INTEGER,
  direction TEXT, scope TEXT, app TEXT, state TEXT,
  first_seen REAL, last_seen REAL, active INTEGER DEFAULT 1,
  rtt REAL, bytes INTEGER
);
CREATE INDEX IF NOT EXISTS ix_conn_last ON connections(last_seen);
CREATE INDEX IF NOT EXISTS ix_conn_ip ON connections(ip);
CREATE INDEX IF NOT EXISTS ix_conn_active ON connections(active);
CREATE TABLE IF NOT EXISTS flags (
  id INTEGER PRIMARY KEY,
  ts REAL, last_ts REAL, ip TEXT, kind TEXT, sev INTEGER, detail TEXT, count INTEGER DEFAULT 1
);
CREATE INDEX IF NOT EXISTS ix_flags_last ON flags(last_ts);
CREATE INDEX IF NOT EXISTS ix_flags_ip ON flags(ip);
CREATE TABLE IF NOT EXISTS bans (
  id INTEGER PRIMARY KEY,
  ts REAL, jail TEXT, ip TEXT, action TEXT,
  UNIQUE(ts, jail, ip, action)
);
CREATE INDEX IF NOT EXISTS ix_bans_ts ON bans(ts);
CREATE TABLE IF NOT EXISTS samples (
  ts INTEGER PRIMARY KEY,
  active INTEGER, ips INTEGER, new_in INTEGER, new_out INTEGER,
  rtt REAL, http INTEGER, flags INTEGER, bans INTEGER
);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS manual_bans (ip TEXT PRIMARY KEY, ts REAL, expires REAL, reason TEXT);
CREATE TABLE IF NOT EXISTS http (id INTEGER PRIMARY KEY, ts REAL, ip TEXT, method TEXT, path TEXT, status INTEGER, ua TEXT);
CREATE INDEX IF NOT EXISTS ix_http_ip ON http(ip, ts);
CREATE INDEX IF NOT EXISTS ix_http_ts ON http(ts);
CREATE TABLE IF NOT EXISTS ipinfo (ip TEXT PRIMARY KEY, ts REAL, data TEXT);
"""


def conn():
    c = getattr(_local, "c", None)
    if c is None:
        os.makedirs(os.path.dirname(DB_PATH) or ".", exist_ok=True)
        c = sqlite3.connect(DB_PATH, timeout=30)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA journal_mode=WAL")
        c.execute("PRAGMA synchronous=NORMAL")
        _local.c = c
    return c


def init():
    c = conn()
    c.executescript(SCHEMA)
    fcols = {r[1] for r in c.execute("PRAGMA table_info(flags)")}
    if "cleared" not in fcols:
        c.execute("ALTER TABLE flags ADD COLUMN cleared REAL")
    if "verified" not in fcols:
        c.execute("ALTER TABLE flags ADD COLUMN verified INTEGER DEFAULT 0")
    cols = {r[1] for r in c.execute("PRAGMA table_info(samples)")}
    for col in ("rx", "tx"):
        if col not in cols:
            c.execute("ALTER TABLE samples ADD COLUMN %s REAL" % col)
    # Les connexions encore marquees actives datent d'un ancien demarrage.
    c.execute("UPDATE connections SET active=0 WHERE active=1")
    c.commit()


def q(sql, args=()):
    return [dict(r) for r in conn().execute(sql, args).fetchall()]


def x(sql, args=()):
    c = conn()
    cur = c.execute(sql, args)
    c.commit()
    return cur.lastrowid


def kv_get(k, default=None):
    rows = conn().execute("SELECT v FROM kv WHERE k=?", (k,)).fetchall()
    return rows[0]["v"] if rows else default


def kv_set(k, v):
    x("INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", (k, str(v)))


def purge(days):
    import time
    lim = time.time() - days * 86400
    c = conn()
    c.execute("DELETE FROM connections WHERE active=0 AND last_seen<?", (lim,))
    c.execute("DELETE FROM flags WHERE last_ts<?", (lim,))
    c.execute("DELETE FROM samples WHERE ts<?", (lim,))
    c.execute("DELETE FROM http WHERE ts<?", (time.time() - min(days, 7) * 86400,))
    c.execute("DELETE FROM ipinfo WHERE ts<?", (lim,))
    c.commit()
