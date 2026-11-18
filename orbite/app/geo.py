"""Position approximative des adresses pour les points sur la Terre. Les adresses publiques sont
envoyees par lots a ip-api.com (au plus 100 par requete, une requete toutes les 5 s), puis
gardees 30 jours. Desactive avec les reglages « lookup » ou « geo_points »."""
import ipaddress
import json
import queue
import threading
import time
import urllib.request

import db
import settings

TTL = 30 * 86400
CACHE = {}              # ip -> (lat, lon, pays, ville) ou None si inconnue
_queue = queue.Queue(maxsize=20000)
_pending = set()
STATE = {"ok": None, "error": "", "pause_until": 0.0}


def enabled():
    return settings.get("lookup") and settings.get("geo_points")


def load():
    now = time.time()
    for r in db.q("SELECT ip, ts, lat, lon, cc, city FROM geo WHERE ts>?", (now - TTL,)):
        CACHE[r["ip"]] = (r["lat"], r["lon"], r["cc"], r["city"]) if r["lat"] is not None else None


def want(ips):
    if not enabled():
        return
    for ip in ips:
        if ip in CACHE or ip in _pending:
            continue
        try:
            if not ipaddress.ip_address(ip).is_global:
                continue
        except ValueError:
            continue
        try:
            _queue.put_nowait(ip)
            _pending.add(ip)
        except queue.Full:
            return


def get(ip):
    return CACHE.get(ip)


def remember(ip, lat, lon, cc, city):
    """Utilise aussi par la fiche d'une adresse, qui recoit deja la position."""
    if lat is None or lon is None:
        return
    CACHE[ip] = (float(lat), float(lon), cc or "", city or "")
    db.x("INSERT OR REPLACE INTO geo(ip,ts,lat,lon,cc,city) VALUES(?,?,?,?,?,?)",
         (ip, time.time(), float(lat), float(lon), cc or "", city or ""))


def _batch(ips):
    body = json.dumps(ips).encode()
    req = urllib.request.Request("http://ip-api.com/batch?fields=status,query,lat,lon,countryCode,city",
                                 data=body, headers={"Content-Type": "application/json", "User-Agent": "Orbite/1.0"})
    with urllib.request.urlopen(req, timeout=10) as r:
        left = r.headers.get("X-Rl")
        data = json.loads(r.read(2000000).decode("utf-8", "replace"))
    return data, left


def _worker():
    while True:
        ip = _queue.get()
        batch = [ip]
        while len(batch) < 100:
            try:
                batch.append(_queue.get_nowait())
            except queue.Empty:
                break
        wait = STATE["pause_until"] - time.time()
        if wait > 0:
            time.sleep(wait)
        if not enabled():
            _pending.difference_update(batch)
            continue
        try:
            data, left = _batch(batch)
            now = time.time()
            c = db.conn()
            for d in data if isinstance(data, list) else []:
                q = d.get("query")
                if not q:
                    continue
                if d.get("status") == "success":
                    CACHE[q] = (float(d.get("lat") or 0), float(d.get("lon") or 0), d.get("countryCode") or "", d.get("city") or "")
                    c.execute("INSERT OR REPLACE INTO geo(ip,ts,lat,lon,cc,city) VALUES(?,?,?,?,?,?)",
                              (q, now, CACHE[q][0], CACHE[q][1], CACHE[q][2], CACHE[q][3]))
                else:
                    CACHE[q] = None
                    c.execute("INSERT OR REPLACE INTO geo(ip,ts,lat,lon,cc,city) VALUES(?,?,NULL,NULL,'','')", (q, now))
            c.commit()
            STATE["ok"], STATE["error"] = True, ""
            if left is not None and left.isdigit() and int(left) <= 1:
                STATE["pause_until"] = time.time() + 61
        except Exception as ex:
            STATE["ok"], STATE["error"] = False, str(ex)[:120]
            STATE["pause_until"] = time.time() + 60
        finally:
            _pending.difference_update(batch)
        time.sleep(5)


def start():
    load()
    threading.Thread(target=_worker, daemon=True, name="geo").start()
