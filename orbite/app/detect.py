"""Regles de detection : balayages, rafales, sondes, robots web, force brute."""
import ipaddress
import os
import threading
import time
from collections import defaultdict, deque

import db
import settings

SEV = {"info": 0, "low": 1, "medium": 2, "high": 3}

HOOKS = []              # fonctions appelees apres chaque signalement : f(ip, kind, sev, now)
_reentry = threading.local()

SENSITIVE = {
    23: "Telnet", 135: "RPC", 139: "NetBIOS", 445: "SMB", 1433: "MSSQL", 2375: "Docker",
    3306: "MySQL", 3389: "RDP", 5432: "PostgreSQL", 5900: "VNC", 6379: "Redis",
    9200: "Elasticsearch", 11211: "Memcached", 27017: "MongoDB",
}
SCAN_PATHS = (
    "/.env", "/.git", "/.aws", "/.ssh", "wp-login", "wp-admin", "xmlrpc.php", "phpmyadmin",
    "/cgi-bin/", "phpunit", "eval-stdin", "/actuator", "/boaform", "/hnap1", "/etc/passwd",
    "../", "/owa/", "/solr/", "/manager/html", "/shell", "/.vscode", "/config.php", "/setup.cgi",
)
SCANNER_UA = (
    "zgrab", "masscan", "nmap", "sqlmap", "nikto", "nuclei", "gobuster", "dirbuster", "wpscan",
    "l9explore", "censys", "shodan", "internet-measurement", "expanse", "paloalto", "httpx",
    "fuzz", "hello, world", "zmeu", "morfeus",
)
GENERIC_UA = ("go-http-client", "python-requests", "python-urllib", "curl/", "wget/", "libwww",
              "scrapy", "aiohttp", "okhttp", "java/")
CRAWLER_UA = ("googlebot", "bingbot", "duckduckbot", "yandex", "baiduspider", "applebot", "gptbot",
              "claudebot", "ahrefs", "semrush", "mj12bot", "bytespider", "petalbot",
              "facebookexternalhit", "uptimerobot", "amazonbot", "ccbot")

_lock = threading.RLock()
_ports = defaultdict(deque)     # ip -> (ts, port)
_new = defaultdict(deque)       # ip -> ts
_probes = defaultdict(deque)    # ip -> ts
_http_err = defaultdict(deque)  # ip -> ts
_auth = defaultdict(deque)      # ip -> ts
_last_prune = 0.0
_status_cache = (0.0, {}, set())
counter = {"flags": 0}
VERIFIED = {}           # ip -> derniere poignee de main TCP complete vue (adresse source non falsifiable)


def mark_verified(ip, now):
    VERIFIED[ip] = now
    if len(VERIFIED) > 50000:
        lim = now - 86400
        for k in [k for k, t in VERIFIED.items() if t < lim]:
            del VERIFIED[k]


def is_verified(ip, now=None):
    t = VERIFIED.get(ip)
    return bool(t and t > (now or time.time()) - 86400)


_wl_cache = (-1, [])
_own_cache = (-1, [])


def _parse_nets(items):
    nets = []
    for part in items:
        try:
            nets.append(ipaddress.ip_network(part, strict=False))
        except ValueError:
            pass
    return nets


def own_nets():
    global _own_cache
    if _own_cache[0] != settings.VERSION["n"] or not settings._values:
        nets = _parse_nets(settings.get("own_ips"))
        _own_cache = (settings.VERSION["n"], nets)
    return _own_cache[1]


def is_own(ip):
    try:
        a = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return any(a.version == n.version and a in n for n in own_nets())


def forget(ip):
    """Oublie les compteurs en memoire d'une adresse (apres « effacer les alertes »)."""
    with _lock:
        for store in (_ports, _new, _probes, _http_err, _auth):
            store.pop(ip, None)


def clear_all(now=None):
    n = db.conn().execute("UPDATE flags SET cleared=? WHERE cleared IS NULL", (now or time.time(),)).rowcount
    db.conn().commit()
    with _lock:
        for store in (_ports, _new, _probes, _http_err, _auth):
            store.clear()
    reset_cache()
    return n


def mark_seen(now=None):
    n = db.conn().execute("UPDATE flags SET seen=? WHERE seen IS NULL", (now or time.time(),)).rowcount
    db.conn().commit()
    return n


def clear_flags(ip, now=None):
    n = db.conn().execute("UPDATE flags SET cleared=? WHERE ip=? AND cleared IS NULL", (now or time.time(), ip)).rowcount
    db.conn().commit()
    forget(ip)
    reset_cache()
    return n


def whitelist():
    global _wl_cache
    v = settings.VERSION["n"]
    if _wl_cache[0] != v or not settings._values:
        nets = []
        for part in settings.get("whitelist"):
            try:
                nets.append(ipaddress.ip_network(part, strict=False))
            except ValueError:
                pass
        _wl_cache = (settings.VERSION["n"], nets)
    return _wl_cache[1]


def whitelisted(ip):
    try:
        a = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return any(a.version == n.version and a in n for n in whitelist())


def skip(ip):
    try:
        a = ipaddress.ip_address(ip)
    except ValueError:
        return True
    if any(a.version == n.version and a in n for n in whitelist()) or is_own(ip):
        return True
    return not a.is_global and not settings.get("flag_lan")


def add_flag(ip, kind, sev, detail, now=None, verified=True):
    now = now or time.time()
    detail = (detail or "")[:300]
    c = db.conn()
    r = c.execute("SELECT id FROM flags WHERE ip=? AND kind=? AND last_ts>? AND cleared IS NULL ORDER BY id DESC LIMIT 1",
                  (ip, kind, now - 600)).fetchall()
    r = r[0] if r else None
    if r:
        c.execute("UPDATE flags SET last_ts=?, count=count+1, detail=?, seen=CASE WHEN ?>sev THEN NULL ELSE seen END, "
                  "sev=MAX(sev,?), verified=MAX(verified,?) WHERE id=?",
                  (now, detail, SEV[sev], SEV[sev], 1 if verified else 0, r["id"]))
    else:
        c.execute("INSERT INTO flags(ts,last_ts,ip,kind,sev,detail,count,verified) VALUES(?,?,?,?,?,?,1,?)",
                  (now, now, ip, kind, SEV[sev], detail, 1 if verified else 0))
        counter["flags"] += 1
    c.commit()
    if getattr(_reentry, "on", False):
        return
    _reentry.on = True
    try:
        for hook in HOOKS:
            try:
                hook(ip, kind, SEV[sev], now, verified)
            except Exception as ex:
                print("[detection] erreur de hook :", repr(ex), flush=True)
    finally:
        _reentry.on = False


def _trim(dq, now, window):
    while dq and (dq[0][0] if isinstance(dq[0], tuple) else dq[0]) < now - window:
        dq.popleft()


def on_flow(ip, direction, lport, proto, replied, now):
    """Appele pour chaque nouvelle connexion vue par le collecteur."""
    if direction != "in" or skip(ip):
        return
    v = is_verified(ip, now)
    with _lock:
        d = _ports[ip]
        d.append((now, lport))
        _trim(d, now, 300)
        ports = sorted({p for _, p in d})
        if len(ports) >= settings.get("portscan_ports"):
            add_flag(ip, "Balayage de ports", "high",
                     "%d ports en 5 min : %s" % (len(ports), ", ".join(map(str, ports[:15]))), now, verified=v)
        n = _new[ip]
        n.append(now)
        _trim(n, now, 60)
        if len(n) >= settings.get("flood_per_min"):
            add_flag(ip, "Rafale de connexions", "medium", "%d connexions en 1 min" % len(n), now, verified=v)
        if not replied:
            p = _probes[ip]
            p.append(now)
            _trim(p, now, 300)
            if len(p) >= settings.get("probes"):
                add_flag(ip, "Sondes sans réponse", "medium",
                         "%d tentatives sans réponse en 5 min" % len(p), now, verified=v)
        if lport in SENSITIVE:
            if replied:
                add_flag(ip, "Port sensible accessible", "high",
                         "Le port %d (%s) a répondu à cette adresse" % (lport, SENSITIVE[lport]), now, verified=v)
            else:
                add_flag(ip, "Sonde sur port sensible", "medium",
                         "Tentative sur le port %d (%s)" % (lport, SENSITIVE[lport]), now, verified=v)
        _prune(now)


def on_reply(ip, lport, now):
    v = is_verified(ip, now)
    if lport in SENSITIVE and not skip(ip):
        add_flag(ip, "Port sensible accessible", "high",
                 "Le port %d (%s) a répondu à cette adresse" % (lport, SENSITIVE[lport]), now, verified=v)


def on_http(ip, method, path, status, ua, now):
    if skip(ip):
        return
    low_ua = (ua or "").lower()
    low_path = (path or "").lower()
    shown = "%s %s (%s)" % (method, path[:120], status)
    with _lock:
        if any(s in low_path for s in SCAN_PATHS) or (status == 404 and low_path.split("?")[0].endswith(".php")):
            add_flag(ip, "Recherche de failles web", "high", shown, now)
        if any(s in low_ua for s in SCANNER_UA):
            add_flag(ip, "Outil de balayage", "medium", "Agent : " + ua[:160], now)
        elif any(s in low_ua for s in CRAWLER_UA):
            if settings.get("flag_crawlers"):
                add_flag(ip, "Robot d'indexation", "info", "Agent : " + ua[:160], now)
        elif low_ua in ("", "-") or any(s in low_ua for s in GENERIC_UA):
            add_flag(ip, "Client automatisé", "low", "Agent : " + (ua[:160] or "(vide)"), now)
        if 400 <= status < 500:
            e = _http_err[ip]
            e.append(now)
            _trim(e, now, 60)
            if len(e) >= settings.get("http_errors_per_min"):
                add_flag(ip, "Erreurs HTTP en série", "medium",
                         "%d erreurs 4xx en 1 min, dernière : %s" % (len(e), shown), now)


def on_auth_fail(ip, what, now):
    if skip(ip):
        return
    with _lock:
        a = _auth[ip]
        a.append(now)
        _trim(a, now, 600)
        if len(a) >= settings.get("auth_fails"):
            add_flag(ip, "Force brute", "high", "%d échecs en 10 min (%s)" % (len(a), what), now)


def on_ban(ip, jail, now):
    add_flag(ip, "Banni par fail2ban", "high", "Jail : " + jail, now)


def _prune(now):
    global _last_prune
    if now - _last_prune < 300:
        return
    _last_prune = now
    for store, window in ((_ports, 300), (_new, 60), (_probes, 300), (_http_err, 60), (_auth, 600)):
        for ip in list(store):
            _trim(store[ip], now, window)
            if not store[ip]:
                del store[ip]


def reset_cache():
    global _status_cache
    _status_cache = (0.0, {}, set())


def banned_now():
    rows = db.q("SELECT jail, ip, action, MAX(ts) AS ts FROM bans GROUP BY jail, ip")
    return [r for r in rows if r["action"] in ("ban", "restore")]


def status_map():
    """ip -> statut (bot, suspect, banned) sur 24 h, mis en cache quelques secondes."""
    global _status_cache
    now = time.time()
    if now - _status_cache[0] < 4:
        return _status_cache[1], _status_cache[2]
    st = {}
    for r in db.q("SELECT ip, MAX(sev) AS s FROM flags WHERE last_ts>? AND cleared IS NULL GROUP BY ip", (now - 86400,)):
        st[r["ip"]] = "suspect" if r["s"] >= 2 else "bot"
    banned = {r["ip"] for r in banned_now()}
    for ip in banned:
        st[ip] = "banned"
    for ip in list(st):
        if is_own(ip) and st[ip] != "banned":
            del st[ip]
    _status_cache = (now, st, banned)
    return st, banned
