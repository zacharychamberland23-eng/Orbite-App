"""Suivi des journaux de l'hote : nginx (acces), auth (SSH) et fail2ban."""
import os
import re
import threading
import time

import collector
import db
import detect

LOG_DIR = os.environ.get("ORBITE_LOG_DIR", "/host/log")
NGINX_LOGS = [p.strip() for p in os.environ.get("ORBITE_NGINX_LOGS", LOG_DIR + "/nginx/access.log").split(",") if p.strip()]
AUTH_LOG = os.environ.get("ORBITE_AUTH_LOG", LOG_DIR + "/auth.log")
F2B_LOG = os.environ.get("ORBITE_F2B_LOG", LOG_DIR + "/fail2ban.log")
STATUS = {}

_NGINX = re.compile(r'^(\S+) \S+ \S+ \[[^\]]+\] "([^"]*)" (\d{3}) \S+(?: "[^"]*" "([^"]*)")?')
_F2B = re.compile(r"^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d),\d+\s+fail2ban\.actions\s+\[\d+\]:\s+\w+\s+"
                  r"\[([^\]]+)\] (Restore Ban|Ban|Unban) (\S+)")
_AUTH = re.compile(r"(Failed password|Invalid user|authentication failure|Connection closed by "
                   r"(?:authenticating|invalid) user).*?(?:from|rhost=)\s*([0-9a-fA-F:.]{3,45})")


class Tail:
    def __init__(self, path, from_start=False):
        self.path = path
        self.key = "tail:" + path
        self.from_start = from_start
        self.buf = b""
        saved = db.kv_get(self.key)
        self.inode, self.offset = (None, None)
        if saved:
            try:
                ino, off = saved.split(":")
                self.inode, self.offset = int(ino), int(off)
            except ValueError:
                pass

    def read(self):
        try:
            st = os.stat(self.path)
        except OSError:
            STATUS[self.path] = False
            return []
        STATUS[self.path] = True
        if self.offset is None:
            self.offset = 0 if self.from_start else st.st_size
        elif self.inode != st.st_ino or st.st_size < self.offset:
            self.offset = 0  # rotation du journal
            self.buf = b""
        self.inode = st.st_ino
        if st.st_size == self.offset:
            return []
        try:
            with open(self.path, "rb") as fh:
                fh.seek(self.offset)
                data = fh.read(8 * 1024 * 1024)
        except OSError:
            return []
        self.offset += len(data)
        data = self.buf + data
        lines = data.split(b"\n")
        self.buf = lines.pop()
        db.kv_set(self.key, "%d:%d" % (self.inode, self.offset - len(self.buf)))
        return [ln.decode("utf-8", "replace") for ln in lines]


def handle_nginx(line, now):
    m = _NGINX.match(line)
    if not m:
        return
    collector.COUNTERS["http"] += 1
    ip = collector.clean_ip(m.group(1))
    req = m.group(2).split(" ")
    method, path = (req[0], req[1]) if len(req) >= 2 else ("?", m.group(2)[:120])
    if collector.scope_of(ip) == "wan":
        db.conn().execute("INSERT INTO http(ts,ip,method,path,status,ua) VALUES(?,?,?,?,?,?)",
                          (now, ip, method[:10], path[:300], int(m.group(3)), (m.group(4) or "")[:300]))
    detect.on_http(ip, method[:10], path, int(m.group(3)), m.group(4) or "", now)


def handle_f2b(line):
    m = _F2B.match(line)
    if not m:
        return
    try:
        ts = time.mktime(time.strptime(m.group(1), "%Y-%m-%d %H:%M:%S"))
    except ValueError:
        ts = time.time()
    action = {"Ban": "ban", "Unban": "unban", "Restore Ban": "restore"}[m.group(3)]
    c = db.conn()
    cur = c.execute("INSERT OR IGNORE INTO bans(ts,jail,ip,action) VALUES(?,?,?,?)",
                    (ts, m.group(2), m.group(4), action))
    c.commit()
    if cur.rowcount and action == "ban":
        collector.COUNTERS["bans"] += 1
        if ts > time.time() - 600:
            detect.on_ban(m.group(4), m.group(2), ts)


def handle_auth(line, now):
    m = _AUTH.search(line)
    if m:
        detect.on_auth_fail(collector.clean_ip(m.group(2)), "SSH", now)


def loop():
    tails = [(Tail(p), "nginx") for p in NGINX_LOGS]
    tails.append((Tail(AUTH_LOG), "auth"))
    tails.append((Tail(F2B_LOG, from_start=True), "f2b"))
    while True:
        now = time.time()
        for tail, kind in tails:
            try:
                for line in tail.read():
                    if kind == "nginx":
                        handle_nginx(line, now)
                    elif kind == "auth":
                        handle_auth(line, now)
                    else:
                        handle_f2b(line)
                db.conn().commit()
            except Exception as ex:
                print("[journaux] erreur sur %s : %r" % (tail.path, ex), flush=True)
        time.sleep(2)


def start():
    threading.Thread(target=loop, daemon=True, name="journaux").start()
