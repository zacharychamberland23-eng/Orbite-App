"""Reglages modifiables depuis l'interface. Les valeurs par defaut viennent du fichier .env,
les changements faits dans l'app sont gardes dans la base de donnees et ont priorite."""
import hashlib
import hmac
import ipaddress
import json
import os
import secrets
import threading

import db

_lock = threading.RLock()
_values = {}
VERSION = {"n": 0}

KINDS = [
    "Balayage de ports", "Recherche de failles web", "Force brute", "Outil de balayage",
    "Sonde sur port sensible", "Port sensible accessible", "Sondes sans réponse",
    "Rafale de connexions", "Erreurs HTTP en série", "Échec de connexion à Orbite",
]


def _env(name, default):
    return os.environ.get(name, default)


def _bool(name, default):
    return _env(name, "1" if default else "0") == "1"


def _list(name):
    return [p.strip() for p in _env(name, "").split(",") if p.strip()]


# cle -> (type, defaut, min, max)
SPEC = {
    "autoban_mode": ("choice", _env("ORBITE_AUTOBAN", "on"), ("off", "test", "on"), None),
    "autoban_instant": ("kinds", ["Balayage de ports", "Recherche de failles web", "Force brute", "Outil de balayage"], None, None),
    "autoban_points": ("int", 6, 2, 100),
    "autoban_window": ("int", 60, 5, 1440),
    "autoban_hours": ("float", 24.0, 0, 8760),
    "autoban_escalate": ("bool", True, None, None),
    "autoban_include_medium": ("bool", True, None, None),
    "portscan_ports": ("int", int(_env("ORBITE_PORTSCAN_PORTS", "6")), 2, 1000),
    "flood_per_min": ("int", int(_env("ORBITE_FLOOD_PER_MIN", "100")), 5, 100000),
    "probes": ("int", int(_env("ORBITE_PROBES", "10")), 2, 10000),
    "http_errors_per_min": ("int", int(_env("ORBITE_HTTP_ERRORS_PER_MIN", "20")), 2, 10000),
    "auth_fails": ("int", int(_env("ORBITE_AUTH_FAILS", "5")), 2, 1000),
    "flag_lan": ("bool", _bool("ORBITE_FLAG_LAN", False), None, None),
    "flag_crawlers": ("bool", True, None, None),
    "whitelist": ("nets", _list("ORBITE_WHITELIST"), None, None),
    "own_ips": ("nets", _list("ORBITE_OWN_IPS"), None, None),
    "ignore_apps": ("words", _list("ORBITE_IGNORE_APPS"), None, None),
    "ignore_ports": ("ports", [int(p) for p in _list("ORBITE_IGNORE_PORTS") if p.isdigit()], None, None),
    "log_lan": ("bool", _bool("ORBITE_LOG_LAN", True), None, None),
    "retention_days": ("int", int(_env("ORBITE_RETENTION_DAYS", "30")), 1, 365),
    "rdns": ("bool", _bool("ORBITE_RDNS", True), None, None),
    "lookup": ("bool", _bool("ORBITE_LOOKUP", True), None, None),
    "enforce_f2b": ("bool", _bool("ORBITE_ENFORCE_F2B", True), None, None),
}


def _clean(key, value):
    typ, default, lo, hi = SPEC[key]
    if typ == "bool":
        return bool(value)
    if typ == "choice":
        if value not in lo:
            raise ValueError("valeur non permise")
        return value
    if typ in ("int", "float"):
        v = (int if typ == "int" else float)(value)
        if v < lo or v > hi:
            raise ValueError("doit être entre %s et %s" % (lo, hi))
        return v
    items = value if isinstance(value, list) else str(value).replace("\n", ",").split(",")
    items = [str(i).strip() for i in items if str(i).strip()]
    if typ == "kinds":
        return [k for k in items if k in KINDS]
    if typ == "nets":
        out = []
        for i in items:
            try:
                out.append(str(ipaddress.ip_network(i, strict=False)))
            except ValueError:
                raise ValueError("« %s » n'est pas une adresse ou une plage valide" % i[:40])
        return out[:200]
    if typ == "ports":
        out = []
        for i in items:
            if not i.isdigit() or not 0 < int(i) < 65536:
                raise ValueError("« %s » n'est pas un port valide" % i[:20])
            out.append(int(i))
        return sorted(set(out))[:200]
    return sorted({i.lower()[:60] for i in items})[:200]


def load():
    try:
        saved = json.loads(db.kv_get("settings", "{}") or "{}")
    except ValueError:
        saved = {}
    vals = {}
    for k, spec in SPEC.items():
        vals[k] = spec[1]
        if k in saved:
            try:
                vals[k] = _clean(k, saved[k])
            except (ValueError, TypeError):
                pass
    with _lock:
        _values.clear()
        _values.update(vals)
        VERSION["n"] += 1


def get(key):
    if not _values:
        load()
    return _values[key]


def all_values():
    if not _values:
        load()
    return dict(_values)


def defaults():
    return {k: v[1] for k, v in SPEC.items()}


def update(changes):
    """Valide puis enregistre. Renvoie un dictionnaire d'erreurs par cle (vide si tout est bon)."""
    errors, clean = {}, {}
    for k, v in (changes or {}).items():
        if k not in SPEC:
            continue
        try:
            clean[k] = _clean(k, v)
        except (ValueError, TypeError) as ex:
            errors[k] = str(ex) or "valeur invalide"
    if errors:
        return errors
    with _lock:
        try:
            saved = json.loads(db.kv_get("settings", "{}") or "{}")
        except ValueError:
            saved = {}
        saved.update(clean)
        db.kv_set("settings", json.dumps(saved))
        load()
    return {}


def reset():
    with _lock:
        db.kv_set("settings", "{}")
        load()


# ---------- mot de passe ----------

def _hash(password, salt=None):
    salt = salt or secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), 200000)
    return "pbkdf2$%s$%s" % (salt, dk.hex())


def check_password(given, env_password):
    stored = db.kv_get("password_hash")
    if stored:
        try:
            _, salt, _ = stored.split("$")
        except ValueError:
            return False
        return hmac.compare_digest(_hash(given, salt), stored)
    return hmac.compare_digest(given.encode(), env_password.encode())


def set_password(new):
    db.kv_set("password_hash", _hash(new))


def password_from_app():
    return bool(db.kv_get("password_hash"))


def clear_password():
    db.x("DELETE FROM kv WHERE k='password_hash'")
