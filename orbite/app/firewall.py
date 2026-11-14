"""Blocage reel des adresses : une table nftables propre a Orbite, placee juste apres le suivi
de connexions et avant la redirection de Docker. Elle refuse toute nouvelle connexion entrante
d'une adresse bannie, vers l'hote et les conteneurs, sur tous les ports, sans toucher a ufw, a
Docker ni a fail2ban. Les connexions que le serveur ouvre lui-meme restent permises."""
import ipaddress
import os
import queue
import subprocess
import threading
import time

import db
import detect
import settings

STATE = {"ok": None, "error": ""}
_applied = {}          # ip -> expiration (None = permanent)
_lock = threading.RLock()
ADMINS = {}            # ip -> expiration : adresses connectees a Orbite, jamais bannies automatiquement
_queue = queue.Queue(maxsize=5000)
_pending = set()
AUTO = {"bans": 0, "simulated": 0, "last_error": ""}
SELF_KINDS = {"Banni depuis Orbite", "Banni par fail2ban", "Bannissement simulé", "Bannissement automatique impossible",
              "Signalée manuellement"}

RULESET = """
table inet orbite
delete table inet orbite
table inet orbite {
  set ban4 { type ipv4_addr; flags timeout; }
  set ban6 { type ipv6_addr; flags timeout; }
  chain orbite_pre { type filter hook prerouting priority -150; policy accept;
    ct state established,related accept
    ip saddr @ban4 counter drop
    ip6 saddr @ban6 counter drop
  }
}
"""


def nft(script):
    try:
        r = subprocess.run(["nft", "-f", "-"], input=script, capture_output=True, text=True, timeout=10)
        return r.returncode == 0, (r.stderr or "").strip()[:200]
    except Exception as ex:
        return False, repr(ex)[:200]


def parse(ip):
    try:
        return ipaddress.ip_address(str(ip).strip())
    except ValueError:
        return None


def protected(ip):
    a = parse(ip)
    if a is None:
        return True
    return (not a.is_global) or detect.whitelisted(ip) or detect.is_own(ip)


def _set(a):
    return "ban4" if a.version == 4 else "ban6"


def _add(ip, seconds):
    a = parse(ip)
    nft("delete element inet orbite %s { %s }\n" % (_set(a), a))
    extra = " timeout %ds" % max(1, int(seconds)) if seconds else ""
    return nft("add element inet orbite %s { %s%s }\n" % (_set(a), a, extra))


def _del(ip):
    a = parse(ip)
    return nft("delete element inet orbite %s { %s }\n" % (_set(a), a))


def _flush(ip):
    for flag in ("-s", "-d"):
        try:
            subprocess.run(["conntrack", "-D", flag, ip], capture_output=True, timeout=10)
        except Exception:
            pass


def ban(ip, seconds, reason):
    a = parse(ip)
    if a is None:
        return False, "Adresse IP invalide."
    ip = str(a)
    if protected(ip):
        return False, "Adresse locale ou en liste blanche : blocage refusé."
    if not STATE["ok"]:
        return False, "Le pare-feu d'Orbite n'est pas actif : " + (STATE["error"] or "nftables indisponible")
    now = time.time()
    exp = now + seconds if seconds else None
    with _lock:
        ok, err = _add(ip, seconds)
        if not ok:
            return False, "Le pare-feu a refusé : " + err
        _applied[ip] = exp
        c = db.conn()
        c.execute("INSERT OR REPLACE INTO manual_bans(ip,ts,expires,reason) VALUES(?,?,?,?)", (ip, now, exp, reason))
        c.execute("INSERT OR IGNORE INTO bans(ts,jail,ip,action) VALUES(?,?,?,?)", (now, "orbite", ip, "ban"))
        c.commit()
    _flush(ip)
    detect.add_flag(ip, "Banni depuis Orbite", "high", reason or "Blocage manuel", now)
    detect.reset_cache()
    return True, ""


def unban(ip):
    a = parse(ip)
    if a is None:
        return False, "Adresse IP invalide."
    ip = str(a)
    with _lock:
        _del(ip)
        _applied.pop(ip, None)
        c = db.conn()
        had = c.execute("DELETE FROM manual_bans WHERE ip=?", (ip,)).rowcount
        if had:
            c.execute("INSERT OR IGNORE INTO bans(ts,jail,ip,action) VALUES(?,?,?,?)", (time.time(), "orbite", ip, "unban"))
        c.commit()
    detect.reset_cache()
    return True, ""


def blocked(ip):
    return ip in _applied


def sync():
    """Aligne le pare-feu sur les bans d'Orbite et, si active, sur ceux de fail2ban."""
    if not STATE["ok"]:
        return
    now = time.time()
    with _lock:
        c = db.conn()
        for r in db.q("SELECT ip FROM manual_bans WHERE expires IS NOT NULL AND expires<=?", (now,)):
            c.execute("DELETE FROM manual_bans WHERE ip=?", (r["ip"],))
            c.execute("INSERT OR IGNORE INTO bans(ts,jail,ip,action) VALUES(?,?,?,?)", (now, "orbite", r["ip"], "unban"))
        c.commit()
        desired = {r["ip"]: r["expires"] for r in db.q("SELECT ip, expires FROM manual_bans")}
        if settings.get("enforce_f2b"):
            for r in detect.banned_now():
                if r["jail"] != "orbite" and not protected(r["ip"]):
                    desired.setdefault(r["ip"], None)
        for ip, exp in desired.items():
            if ip not in _applied or _applied[ip] != exp:
                new = ip not in _applied
                ok, _ = _add(ip, (exp - now) if exp else None)
                if ok:
                    _applied[ip] = exp
                    if new:
                        _flush(ip)
        for ip in [i for i in _applied if i not in desired]:
            _del(ip)
            _applied.pop(ip, None)


# ---------- bannissement automatique ----------

def note_admin(ip):
    ADMINS[ip] = time.time() + 6 * 3600


def is_admin(ip):
    exp = ADMINS.get(ip)
    if exp and exp > time.time():
        return True
    ADMINS.pop(ip, None)
    return False


def consider(ip, kind, sev, now, verified=True):
    """Appele apres chaque signalement. Le travail se fait dans un fil separe.
    Une alerte basee sur des paquets dont l'adresse source peut etre falsifiee (SYN ou UDP sans
    poignee de main) ne declenche jamais de bannissement : sinon, n'importe qui pourrait faire
    bannir une adresse innocente en usurpant son IP."""
    if kind in SELF_KINDS or settings.get("autoban_mode") == "off" or sev < 2 or not verified:
        return
    if ip in _applied or ip in _pending:
        return
    try:
        _queue.put_nowait((ip, kind, now))
        _pending.add(ip)
    except queue.Full:
        pass


def _points(ip, now):
    win = now - settings.get("autoban_window") * 60
    medium = settings.get("autoban_include_medium")
    pts = 0
    marks = ",".join("?" * len(SELF_KINDS))
    for r in db.q("SELECT sev, count FROM flags WHERE ip=? AND last_ts>? AND cleared IS NULL AND verified=1 "
                  "AND kind NOT IN (%s)" % marks,
                  (ip, win) + tuple(SELF_KINDS)):
        w = 3 if r["sev"] >= 3 else (1 if r["sev"] == 2 and medium else 0)
        pts += w * min(r["count"] or 1, 5)
    return pts


def _human(hours):
    if not hours:
        return "permanent"
    if hours < 24:
        return "%g h" % round(hours, 1)
    return "%g j" % round(hours / 24, 1)


def _decide(ip, kind, now):
    mode = settings.get("autoban_mode")
    if mode == "off" or ip in _applied or protected(ip) or is_admin(ip):
        return
    if db.q("SELECT 1 FROM manual_bans WHERE ip=?", (ip,)):
        return
    if kind in settings.get("autoban_instant"):
        why = kind
    else:
        pts = _points(ip, now)
        if pts < settings.get("autoban_points"):
            return
        why = "%d points en %d min (dernier : %s)" % (pts, settings.get("autoban_window"), kind)
    hours = float(settings.get("autoban_hours"))
    prior = db.q("SELECT COUNT(*) AS n FROM bans WHERE ip=? AND jail='orbite' AND action='ban'", (ip,))[0]["n"]
    if hours and settings.get("autoban_escalate") and prior:
        hours = min(hours * (2 ** prior), 24 * 365)
        why += " · récidive n° %d" % prior
    reason = "Automatique : " + why
    if mode == "test":
        AUTO["simulated"] += 1
        detect.add_flag(ip, "Bannissement simulé", "medium",
                        "Mode test, aurait été bannie (%s) : %s" % (_human(hours), why), now)
        return
    ok, err = ban(ip, int(hours * 3600) if hours else None, reason)
    if ok:
        AUTO["bans"] += 1
        print("[auto-ban] %s bannie (%s) : %s" % (ip, _human(hours), why), flush=True)
    else:
        AUTO["last_error"] = err
        detect.add_flag(ip, "Bannissement automatique impossible", "medium", err, now)


def _worker():
    while True:
        ip, kind, now = _queue.get()
        try:
            _decide(ip, kind, now)
        except Exception as ex:
            print("[auto-ban] erreur :", repr(ex), flush=True)
        finally:
            _pending.discard(ip)


def loop():
    ok, err = nft(RULESET)
    STATE["ok"], STATE["error"] = ok, err
    if not ok:
        print("[pare-feu] inactif :", err, flush=True)
    while True:
        try:
            sync()
        except Exception as ex:
            print("[pare-feu] erreur :", repr(ex), flush=True)
        time.sleep(20)


def start():
    detect.HOOKS.append(consider)
    threading.Thread(target=loop, daemon=True, name="pare-feu").start()
    threading.Thread(target=_worker, daemon=True, name="auto-ban").start()
