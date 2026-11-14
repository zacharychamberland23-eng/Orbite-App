"""Renseignements externes sur une adresse, a la demande seulement : RDAP (registre officiel
du reseau) et ip-api.com (pays, fournisseur, type). Resultats gardes 7 jours."""
import ipaddress
import json
import os
import time
import urllib.parse
import urllib.request

import db
import settings

TTL = 7 * 86400


def _fetch(url, timeout=6):
    req = urllib.request.Request(url, headers={"User-Agent": "Orbite/1.0", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read(400000).decode("utf-8", "replace"))


def _vcard(entity, field):
    try:
        for item in entity.get("vcardArray", [None, []])[1]:
            if item[0] == field and isinstance(item[3], str):
                return item[3]
    except Exception:
        pass
    return ""


def _rdap(ip):
    d = _fetch("https://rdap.org/ip/" + urllib.parse.quote(ip))
    out = {"network": d.get("name") or "", "handle": d.get("handle") or "", "net_country": d.get("country") or "",
           "range": "", "registered": "", "abuse": "", "owner": ""}
    cidrs = d.get("cidr0_cidrs") or []
    if cidrs:
        c = cidrs[0]
        out["range"] = "%s/%s" % (c.get("v4prefix") or c.get("v6prefix"), c.get("length"))
    elif d.get("startAddress"):
        out["range"] = "%s – %s" % (d.get("startAddress"), d.get("endAddress"))
    for ev in d.get("events") or []:
        if ev.get("eventAction") == "registration":
            out["registered"] = (ev.get("eventDate") or "")[:10]

    def walk(ents):
        for e in ents or []:
            roles = e.get("roles") or []
            if "abuse" in roles and not out["abuse"]:
                out["abuse"] = _vcard(e, "email")
            if ("registrant" in roles or "administrative" in roles) and not out["owner"]:
                out["owner"] = _vcard(e, "fn")
            walk(e.get("entities"))
    walk(d.get("entities"))
    return out


def _geo(ip):
    fields = "status,message,country,countryCode,regionName,city,isp,org,as,asname,mobile,proxy,hosting"
    d = _fetch("http://ip-api.com/json/%s?fields=%s&lang=fr" % (urllib.parse.quote(ip), fields))
    if d.get("status") != "success":
        raise ValueError(d.get("message") or "échec")
    return {k: d.get(k) for k in ("country", "countryCode", "regionName", "city", "isp", "org", "as", "asname",
                                  "mobile", "proxy", "hosting")}


def lookup(ip):
    try:
        a = ipaddress.ip_address(ip)
    except ValueError:
        return {"error": "Adresse invalide."}
    if not a.is_global:
        return {"local": True}
    if not settings.get("lookup"):
        return {"disabled": True}
    row = db.q("SELECT ts, data FROM ipinfo WHERE ip=?", (ip,))
    if row and row[0]["ts"] > time.time() - TTL:
        try:
            return json.loads(row[0]["data"])
        except ValueError:
            pass
    out, errors = {}, []
    for name, fn in (("geo", _geo), ("rdap", _rdap)):
        try:
            out[name] = fn(ip)
        except Exception as ex:
            errors.append("%s : %s" % (name, str(ex)[:80]))
    if errors:
        out["errors"] = errors
    if "geo" in out or "rdap" in out:
        db.x("INSERT OR REPLACE INTO ipinfo(ip,ts,data) VALUES(?,?,?)", (ip, time.time(), json.dumps(out)))
    return out
