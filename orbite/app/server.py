"""Orbite : serveur web, connexion par mot de passe et API."""
import hmac
import ipaddress
import json
import mimetypes
import os
import secrets
import socket
import sys
import threading
import time
from collections import defaultdict, deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import collector
import db
import detect
import f2b
import firewall
import ipinfo
import logs
import settings

USER = os.environ.get("ORBITE_USER", "admin")
PASSWORD = os.environ.get("ORBITE_PASSWORD", "")
BIND = os.environ.get("ORBITE_BIND", "127.0.0.1")
PORT = int(os.environ.get("ORBITE_PORT", "8095"))
SESSION_HOURS = int(os.environ.get("ORBITE_SESSION_HOURS", "168"))
STATIC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
COOKIE = "orbite_session"

SESSIONS = {}                    # jeton -> expiration
FAILS = defaultdict(deque)       # ip -> echecs de connexion
_lock = threading.Lock()

RANGES = {"1h": (3600, 60), "12h": (43200, 300), "24h": (86400, 600),
          "7d": (604800, 3600), "30d": (2592000, 14400)}
SEV_NAMES = ["info", "low", "medium", "high"]


class Handler(BaseHTTPRequestHandler):
    server_version = "Orbite"
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    # ----- utilitaires -----
    def client_ip(self):
        peer = self.client_address[0]
        if peer in ("127.0.0.1", "::1"):
            # Seul X-Real-IP, ecrit par nginx, est fiable. X-Forwarded-For peut etre forge par le client.
            real = (self.headers.get("X-Real-IP") or "").strip()
            try:
                return str(ipaddress.ip_address(real))
            except ValueError:
                pass
        return peer

    def send(self, code, body=b"", ctype="application/json; charset=utf-8", extra=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy",
                         "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
                         "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        if ctype.startswith("application/json"):
            self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def token(self):
        for part in (self.headers.get("Cookie") or "").split(";"):
            k, _, v = part.strip().partition("=")
            if k == COOKIE:
                return v
        return ""

    def authed(self):
        t = self.token()
        with _lock:
            exp = SESSIONS.get(t)
            if exp and exp > time.time():
                return True
            SESSIONS.pop(t, None)
        return False

    def body_json(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
            if n <= 0:
                return {}
            if n > 65536:
                self.close_connection = True
                return {}
            raw = self.rfile.read(n)
            data = json.loads(raw) if len(raw) <= 4096 else {}
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}

    # ----- routes -----
    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        u = urlparse(self.path)
        qs = {k: v[0] for k, v in parse_qs(u.query).items()}
        try:
            if u.path == "/" or u.path == "/index.html":
                return self.static("index.html")
            if u.path.startswith("/static/"):
                return self.static(u.path[8:])
            if u.path == "/api/me":
                ok = self.authed()
                return self.send(200, {"auth": ok, "user": USER if ok else None, "host": socket.gethostname() if ok else ""})
            if not u.path.startswith("/api/"):
                return self.send(404, {"error": "introuvable"})
            if not self.authed():
                return self.send(401, {"error": "non connecté"})
            firewall.note_admin(self.client_ip())
            route = {"/api/live": self.api_live, "/api/connections": self.api_connections,
                     "/api/flags": self.api_flags, "/api/bans": self.api_bans,
                     "/api/series": self.api_series, "/api/status": self.api_status,
                     "/api/ip": self.api_ip, "/api/ipinfo": self.api_ipinfo,
                     "/api/settings": self.api_settings}.get(u.path)
            if not route:
                return self.send(404, {"error": "introuvable"})
            return self.send(200, route(qs))
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as ex:
            print("[web] erreur :", repr(ex), flush=True)
            try:
                self.send(500, {"error": "erreur interne"})
            except Exception:
                pass

    def do_POST(self):
        u = urlparse(self.path)
        if self.headers.get("Transfer-Encoding"):
            self.close_connection = True
            return self.send(411, {"error": "longueur requise"})
        data = self.body_json()  # toujours lire le corps pour garder la connexion saine
        if "application/json" not in (self.headers.get("Content-Type") or ""):
            return self.send(415, {"error": "format non pris en charge"})
        if u.path == "/api/login":
            return self.login(data)
        if u.path == "/api/logout":
            with _lock:
                SESSIONS.pop(self.token(), None)
            return self.send(200, {"ok": True}, extra={"Set-Cookie": COOKIE + "=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict"})
        if not self.authed():
            return self.send(401, {"error": "non connecté"})
        firewall.note_admin(self.client_ip())
        try:
            if u.path == "/api/settings":
                errors = settings.update(data.get("changes") or {})
                detect.reset_cache()
                return self.send(400 if errors else 200, {"ok": not errors, "errors": errors, "values": settings.all_values()})
            if u.path == "/api/settings/reset":
                settings.reset()
                detect.reset_cache()
                return self.send(200, {"ok": True, "values": settings.all_values()})
            if u.path == "/api/password":
                return self.change_password(data)
            if u.path == "/api/ban":
                return self.api_ban(data)
            if u.path == "/api/unban":
                return self.api_unban(data)
            if u.path == "/api/unflag":
                a = firewall.parse(data.get("ip", ""))
                if a is None:
                    return self.send(400, {"error": "Adresse IP invalide."})
                return self.send(200, {"ok": True, "cleared": detect.clear_flags(str(a))})
            if u.path == "/api/flag":
                return self.api_flag(data)
            if u.path == "/api/trust":
                return self.api_trust(data)
        except Exception as ex:
            print("[web] erreur :", repr(ex), flush=True)
            return self.send(500, {"error": "erreur interne"})
        self.send(404, {"error": "introuvable"})

    def api_unban(self, data):
        a = firewall.parse(data.get("ip", ""))
        if a is None:
            return self.send(400, {"error": "Adresse IP invalide."})
        ip, errors = str(a), []
        ok, err = firewall.unban(ip)
        if not ok:
            errors.append(err)
        jails = [r["jail"] for r in detect.banned_now() if r["ip"] == ip and r["jail"] != "orbite"]
        if jails:
            ok2, err2 = f2b.unban(ip)
            if ok2:
                now = time.time()
                c = db.conn()
                for j in jails:
                    c.execute("INSERT OR IGNORE INTO bans(ts,jail,ip,action) VALUES(?,?,?,?)", (now, j, ip, "unban"))
                c.commit()
                detect.reset_cache()
                firewall.sync()
            else:
                errors.append(err2)
        still = [r["jail"] for r in detect.banned_now() if r["ip"] == ip]
        return self.send(200 if not errors else 400, {"ok": not errors, "error": " ".join(errors), "still": still})

    def api_flag(self, data):
        a = firewall.parse(data.get("ip", ""))
        if a is None:
            return self.send(400, {"error": "Adresse IP invalide."})
        sev = "high" if data.get("sev") == "high" else "medium"
        note = str(data.get("note") or "").strip()[:200] or "Signalée depuis Orbite"
        detect.add_flag(str(a), "Signalée manuellement", sev, note)
        detect.reset_cache()
        return self.send(200, {"ok": True})

    def api_trust(self, data):
        a = firewall.parse(data.get("ip", ""))
        key = data.get("list")
        if a is None or key not in ("whitelist", "own_ips"):
            return self.send(400, {"error": "Demande invalide."})
        ip = str(a)
        cur = list(settings.get(key))
        if data.get("add"):
            if ip not in cur:
                cur.append(ip)
        else:
            cur = [x for x in cur if x not in (ip, ip + "/32", ip + "/128")]
        errors = settings.update({key: cur})
        if errors:
            return self.send(400, {"error": "; ".join(errors.values())})
        if data.get("add"):
            detect.clear_flags(ip)
            firewall.unban(ip)
        detect.reset_cache()
        return self.send(200, {"ok": True})

    def change_password(self, data):
        cur, new = str(data.get("current", "")), str(data.get("new", ""))
        if not settings.check_password(cur, PASSWORD):
            time.sleep(0.6)
            return self.send(400, {"error": "Le mot de passe actuel est incorrect."})
        if len(new) < 10:
            return self.send(400, {"error": "Le nouveau mot de passe doit faire au moins 10 caractères."})
        if new == cur:
            return self.send(400, {"error": "Le nouveau mot de passe doit être différent de l'actuel."})
        settings.set_password(new)
        keep = self.token()
        with _lock:
            for k in [k for k in SESSIONS if k != keep]:
                del SESSIONS[k]
        return self.send(200, {"ok": True})

    def api_ban(self, data):
        ip = str(data.get("ip", "")).strip()
        a = firewall.parse(ip)
        if a is None:
            return self.send(400, {"error": "Adresse IP invalide."})
        if str(a) == self.client_ip():
            return self.send(400, {"error": "C'est ton adresse actuelle : blocage refusé."})
        try:
            hours = float(data.get("hours") or 0)
        except (TypeError, ValueError):
            hours = 0
        seconds = int(hours * 3600) if 0 < hours <= 24 * 365 else None
        ok, err = firewall.ban(str(a), seconds, str(data.get("reason") or "")[:120])
        self.send(200 if ok else 400, {"ok": ok, "error": err})

    def login(self, data):
        ip = self.client_ip()
        now = time.time()
        with _lock:
            if len(FAILS) > 5000:
                for k in [k for k, d in FAILS.items() if not d or d[-1] < now - 900]:
                    del FAILS[k]
            f = FAILS[ip]
            while f and f[0] < now - 900:
                f.popleft()
            blocked = len(f) >= 5
        if blocked:
            return self.send(429, {"error": "Trop d'essais. Réessaie dans 15 minutes."})
        ok_user = hmac.compare_digest(str(data.get("user", "")).encode(), USER.encode())
        ok_pass = settings.check_password(str(data.get("password", "")), PASSWORD)
        if not (ok_user and ok_pass):
            with _lock:
                FAILS[ip].append(now)
                n = len(FAILS[ip])
            try:
                detect.add_flag(ip, "Échec de connexion à Orbite", "high" if n >= 5 else "medium",
                                "%d essai(s) raté(s) sur la page de connexion" % n, now)
            except Exception:
                pass
            time.sleep(0.6)
            return self.send(401, {"error": "Identifiants incorrects."})
        tok = secrets.token_urlsafe(32)
        with _lock:
            FAILS.pop(ip, None)
            for k in [k for k, v in SESSIONS.items() if v < now]:
                del SESSIONS[k]
            SESSIONS[tok] = now + SESSION_HOURS * 3600
        cookie = "%s=%s; Path=/; Max-Age=%d; HttpOnly; SameSite=Strict" % (COOKIE, tok, SESSION_HOURS * 3600)
        if (self.headers.get("X-Forwarded-Proto") or "").lower() == "https":
            cookie += "; Secure"
        self.send(200, {"ok": True, "user": USER}, extra={"Set-Cookie": cookie})

    def static(self, name):
        path = os.path.realpath(os.path.join(STATIC, name))
        if not path.startswith(os.path.realpath(STATIC) + os.sep) or not os.path.isfile(path):
            return self.send(404, {"error": "introuvable"})
        with open(path, "rb") as fh:
            data = fh.read()
        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype.endswith(("javascript", "json")):
            ctype += "; charset=utf-8"
        self.send(200, data, ctype, {"Cache-Control": "no-cache"})

    # ----- API -----
    def api_live(self, qs):
        stats, nodes = collector.snapshot()
        st, banned = detect.status_map()
        now = time.time()
        for n in nodes:
            n["status"] = "self" if detect.is_own(n["ip"]) else st.get(n["ip"], "ok")
        order = {"banned": 0, "suspect": 1, "bot": 2, "ok": 3, "self": 4}
        nodes.sort(key=lambda n: (order[n["status"]], -n["conns"]))
        stats["flags24h"] = db.q("SELECT COUNT(*) AS n FROM flags WHERE last_ts>? AND sev>=2 AND cleared IS NULL", (now - 86400,))[0]["n"]
        stats["banned"] = len(banned)
        last = db.q("SELECT http FROM samples ORDER BY ts DESC LIMIT 1")
        stats["http_rpm"] = last[0]["http"] if last else 0
        stats["blocked"] = len(firewall._applied)
        stats["suspects"] = sum(1 for n in nodes if n["status"] in ("suspect", "banned"))
        apps = defaultdict(int)
        for n in nodes:
            for a in n["apps"]:
                apps[a] += n["conns"] if len(n["apps"]) == 1 else 1
        top = sorted(apps.items(), key=lambda kv: -kv[1])[:8]
        return {"stats": stats, "nodes": nodes[:400], "total_nodes": len(nodes),
                "apps": [{"app": a, "conns": c} for a, c in top], "ts": now}

    def api_connections(self, qs):
        where, args = [], []
        if qs.get("active") == "1":
            where.append("active=1")
        if qs.get("dir") in ("in", "out"):
            where.append("direction=?")
            args.append(qs["dir"])
        if qs.get("scope") in ("wan", "lan"):
            where.append("scope=?")
            args.append(qs["scope"])
        term = (qs.get("q") or "").strip()[:80]
        if term:
            like = "%" + term.replace("%", "").replace("_", "") + "%"
            if term.isdigit():
                where.append("(lport=? OR rport=? OR ip LIKE ?)")
                args += [int(term), int(term), like]
            else:
                where.append("(ip LIKE ? OR app LIKE ?)")
                args += [like, like]
        if (qs.get("before") or "").isdigit():
            where.append("id<?")
            args.append(int(qs["before"]))
        limit = min(500, int(qs["limit"])) if (qs.get("limit") or "").isdigit() else 200
        sql = "SELECT * FROM connections" + (" WHERE " + " AND ".join(where) if where else "") + \
              " ORDER BY id DESC LIMIT ?"
        rows = db.q(sql, args + [limit])
        st, _ = detect.status_map()
        with collector.LOCK:
            live = {f["id"]: f for f in collector.FLOWS.values()}
        for r in rows:
            f = live.get(r["id"])
            if f:  # valeurs en direct pour les connexions encore suivies
                r.update(last_seen=f["last"], rtt=f["rtt"], bytes=f["bytes"], state=f["state"],
                         active=1 if f["open"] else 0, app=f["app"])
            r["status"] = st.get(r["ip"], "ok")
            r["host"] = collector.RDNS_CACHE.get(r["ip"], "")
        return {"rows": rows, "more": len(rows) == limit}

    def api_flags(self, qs):
        where, args = ["1=1"], []
        if qs.get("cleared") != "1":
            where.append("cleared IS NULL")
        if (qs.get("min") or "").isdigit():
            where.append("sev>=?")
            args.append(int(qs["min"]))
        term = (qs.get("q") or "").strip()[:80]
        if term:
            like = "%" + term.replace("%", "").replace("_", "") + "%"
            where.append("(ip LIKE ? OR kind LIKE ? OR detail LIKE ?)")
            args += [like, like, like]
        limit = min(500, int(qs["limit"])) if (qs.get("limit") or "").isdigit() else 200
        rows = db.q("SELECT * FROM flags WHERE " + " AND ".join(where) + " ORDER BY last_ts DESC LIMIT ?",
                    args + [limit])
        _, banned = detect.status_map()
        for r in rows:
            r["severity"] = SEV_NAMES[max(0, min(3, r["sev"] or 0))]
            r["banned"] = r["ip"] in banned
            r["host"] = collector.RDNS_CACHE.get(r["ip"], "")
        return {"rows": rows}

    def api_bans(self, qs):
        now = time.time()
        current = sorted(detect.banned_now(), key=lambda r: -r["ts"])
        events = db.q("SELECT ts,jail,ip,action FROM bans ORDER BY ts DESC LIMIT 500")
        d24 = db.q("SELECT COUNT(*) AS n FROM bans WHERE action='ban' AND ts>?", (now - 86400,))[0]["n"]
        jails = db.q("SELECT jail, COUNT(*) AS n FROM bans WHERE action='ban' GROUP BY jail ORDER BY n DESC")
        manual = {r["ip"]: r for r in db.q("SELECT * FROM manual_bans")}
        for r in current:
            r["manual"] = r["jail"] == "orbite"
            r["auto"] = False
            r["blocked"] = firewall.blocked(r["ip"])
            m = manual.get(r["ip"]) if r["manual"] else None
            r["expires"] = m["expires"] if m else None
            r["reason"] = m["reason"] if m else ""
            r["auto"] = bool(m and (m["reason"] or "").startswith("Automatique"))
            r["host"] = collector.RDNS_CACHE.get(r["ip"], "")
        return {"current": current, "events": events, "bans24h": d24, "jails": jails,
                "log_found": bool(logs.STATUS.get(logs.F2B_LOG)), "f2b_unban": f2b.available(),
                "firewall": {"ok": firewall.STATE["ok"], "error": firewall.STATE["error"],
                             "enforce_f2b": settings.get("enforce_f2b")},
                "autoban": settings.get("autoban_mode"),
                "auto24h": db.q("SELECT COUNT(*) AS n FROM manual_bans WHERE reason LIKE 'Automatique%' AND ts>?",
                                (now - 86400,))[0]["n"]}

    def api_series(self, qs):
        span, bucket = RANGES.get(qs.get("range"), RANGES["1h"])
        since = int(time.time()) - span
        rows = db.q(
            "SELECT (ts/?)*? AS t, AVG(active) AS active, AVG(ips) AS ips, SUM(new_in) AS new_in, "
            "SUM(new_out) AS new_out, AVG(rtt) AS rtt, SUM(http) AS http, SUM(flags) AS flags, "
            "SUM(bans) AS bans, AVG(rx) AS rx, AVG(tx) AS tx FROM samples WHERE ts>=? GROUP BY t ORDER BY t", (bucket, bucket, since))
        return {"bucket": bucket, "since": since, "rows": rows}

    def api_status(self, qs):
        i = collector.INFO
        return {"conntrack": i["conntrack"], "process_names": i["ss_proc"], "docker": i["docker"],
                "logs": logs.STATUS, "uptime": time.time() - i["started"],
                "last_tick": i["last_tick"], "tracked": len(collector.FLOWS),
                "firewall": firewall.STATE["ok"], "firewall_error": firewall.STATE["error"]}

    def api_settings(self, qs):
        i = collector.INFO
        try:
            size = sum(os.path.getsize(db.DB_PATH + s) for s in ("", "-wal") if os.path.exists(db.DB_PATH + s))
        except OSError:
            size = None
        counts = db.q("SELECT (SELECT COUNT(*) FROM connections) AS connections, (SELECT COUNT(*) FROM flags) AS flags, "
                      "(SELECT COUNT(*) FROM http) AS http, (SELECT COUNT(*) FROM bans) AS bans")[0]
        return {"values": settings.all_values(), "defaults": settings.defaults(), "kinds": settings.KINDS,
                "password_from_app": settings.password_from_app(), "user": USER,
                "system": {"conntrack": i["conntrack"], "process_names": i["ss_proc"], "docker": i["docker"],
                           "firewall": firewall.STATE["ok"], "firewall_error": firewall.STATE["error"],
                           "logs": logs.STATUS, "uptime": time.time() - i["started"], "db_size": size,
                           "tracked": len(collector.FLOWS), "blocked": len(firewall._applied),
                           "auto_bans": firewall.AUTO["bans"], "auto_simulated": firewall.AUTO["simulated"],
                           "auto_error": firewall.AUTO["last_error"], "interval": collector.INTERVAL,
                           "counts": counts, "host": socket.gethostname(), "your_ip": self.client_ip()}}

    def api_ipinfo(self, qs):
        a = firewall.parse(qs.get("ip", ""))
        return ipinfo.lookup(str(a)) if a else {"error": "Adresse invalide."}

    def api_ip(self, qs):
        a = firewall.parse(qs.get("ip", ""))
        if a is None:
            return {"error": "Adresse IP invalide."}
        ip, now = str(a), time.time()
        st, _ = detect.status_map()
        host = collector.RDNS_CACHE.get(ip)
        if host is None and a.is_global and settings.get("rdns"):
            box = {}
            t = threading.Thread(target=lambda: box.update(h=_rdns(ip)), daemon=True)
            t.start()
            t.join(2.5)
            host = box.get("h", "")
            if "h" in box:
                collector.RDNS_CACHE[ip] = host
        s = db.q("SELECT COUNT(*) AS total, MIN(first_seen) AS first, MAX(last_seen) AS last, SUM(bytes) AS bytes, "
                 "AVG(rtt) AS rtt, SUM(direction='in') AS n_in, SUM(direction='out') AS n_out "
                 "FROM connections WHERE ip=?", (ip,))[0]
        with collector.LOCK:
            live = [f for f in collector.FLOWS.values() if f["ip"] == ip and collector.is_live(f)]
        s["active"] = len(live)
        apps = db.q("SELECT app, COUNT(*) AS n FROM connections WHERE ip=? GROUP BY app ORDER BY n DESC LIMIT 12", (ip,))
        ports = db.q("SELECT CASE WHEN direction='in' THEN lport ELSE rport END AS port, proto, direction, COUNT(*) AS n "
                     "FROM connections WHERE ip=? GROUP BY port, proto, direction ORDER BY n DESC LIMIT 20", (ip,))
        hours = db.q("SELECT CAST(first_seen/3600 AS INTEGER)*3600 AS t, COUNT(*) AS n FROM connections "
                     "WHERE ip=? AND first_seen>? GROUP BY t ORDER BY t", (ip, now - 48 * 3600))
        flags = db.q("SELECT * FROM flags WHERE ip=? ORDER BY last_ts DESC LIMIT 60", (ip,))
        for f in flags:
            f["severity"] = SEV_NAMES[max(0, min(3, f["sev"] or 0))]
        http = db.q("SELECT ts,method,path,status,ua FROM http WHERE ip=? ORDER BY id DESC LIMIT 80", (ip,))
        hs = db.q("SELECT COUNT(*) AS n, SUM(status>=400) AS errors, COUNT(DISTINCT path) AS paths FROM http WHERE ip=?", (ip,))[0]
        agents = db.q("SELECT ua, COUNT(*) AS n FROM http WHERE ip=? GROUP BY ua ORDER BY n DESC LIMIT 6", (ip,))
        conns = db.q("SELECT * FROM connections WHERE ip=? ORDER BY id DESC LIMIT 25", (ip,))
        events = db.q("SELECT ts,jail,ip,action FROM bans WHERE ip=? ORDER BY ts DESC LIMIT 50", (ip,))
        jails = [r["jail"] for r in detect.banned_now() if r["ip"] == ip]
        m = db.q("SELECT * FROM manual_bans WHERE ip=?", (ip,))
        return {"ip": ip, "status": "self" if detect.is_own(ip) else st.get(ip, "ok"), "host": host or "", "scope": collector.scope_of(ip),
                "version": a.version, "protected": firewall.protected(ip), "whitelisted": detect.whitelisted(ip),
                "blocked": firewall.blocked(ip), "jails": jails, "manual": m[0] if m else None,
                "is_you": ip == self.client_ip(), "own": detect.is_own(ip), "f2b_unban": f2b.available(),
                "active_flags": sum(1 for f in flags if not f.get("cleared")), "summary": s, "apps": apps, "ports": ports, "hours": hours,
                "flags": flags, "http": http, "http_stats": hs, "agents": agents, "connections": conns,
                "events": events, "lookup": settings.get("lookup"), "firewall": firewall.STATE["ok"]}


def _rdns(ip):
    try:
        return socket.gethostbyaddr(ip)[0]
    except Exception:
        return ""


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        ex = sys.exc_info()[1]
        if not isinstance(ex, (BrokenPipeError, ConnectionResetError, TimeoutError)):
            print("[web] erreur de connexion :", repr(ex), flush=True)


def main():
    db.init()
    settings.load()
    weak = len(PASSWORD) < 8 or PASSWORD.lower() in ("changeme", "change-moi", "motdepasse", "password")
    if weak and not settings.password_from_app():
        print("ERREUR : définis ORBITE_PASSWORD dans le fichier .env (8 caractères ou plus).", flush=True)
        sys.exit(1)
    collector.start()
    logs.start()
    firewall.start()
    srv = Server((BIND, PORT), Handler)
    print("Orbite écoute sur http://%s:%d" % (BIND, PORT), flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
