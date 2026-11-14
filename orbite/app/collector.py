"""Collecte des connexions de l'hote : conntrack (tout le trafic, conteneurs compris),
ss (nom du programme et latence TCP) et l'API Docker (nom des conteneurs)."""
import functools
import http.client
import ipaddress
import json
import os
import queue
import re
import socket
import subprocess
import threading
import time

import db
import detect
import settings

INTERVAL = max(2, int(os.environ.get("ORBITE_INTERVAL", "5")))
DOCKER_SOCK = os.environ.get("ORBITE_DOCKER_SOCK", "/var/run/docker.sock")
BRIDGE_PREFIXES = ("docker", "br-", "pterodactyl", "podman", "cni", "virbr", "veth")
OPEN_TCP = {"SYN_SENT", "SYN_RECV", "ESTABLISHED"}

LOCK = threading.RLock()
FLOWS = {}                 # cle -> flux
HOST_ADDRS = set()
BRIDGE_NETS = []
CONTAINERS = {}            # ip du conteneur -> nom
LISTENERS = {}             # (proto, port) -> programme
RDNS_CACHE = {}
_rdns_q = queue.Queue(maxsize=2000)
COUNTERS = {"new_in": 0, "new_out": 0, "http": 0, "bans": 0}
NET = {"rx": None, "tx": None, "t": 0.0, "rx_bps": 0.0, "tx_bps": 0.0, "acc_rx": 0, "acc_tx": 0, "acc_t": 0.0}
VIRTUAL = BRIDGE_PREFIXES + ("lo", "tun", "tap", "wg", "tailscale", "lxc", "dummy", "bonding_masters")
INFO = {"conntrack": False, "ss_proc": False, "docker": False, "started": time.time(), "last_tick": 0.0}


def run(cmd, timeout=15):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout).stdout
    except Exception:
        return ""


def clean_ip(s):
    s = s.strip("[]").split("%")[0]
    if s.startswith("::ffff:") and "." in s:
        s = s[7:]
    return s


@functools.lru_cache(maxsize=20000)
def _addr(ip):
    try:
        return ipaddress.ip_address(ip)
    except ValueError:
        return None


def is_bridge(ip):
    if ip in CONTAINERS:
        return True
    a = _addr(ip)
    return a is not None and any(a.version == n.version and a in n for n in BRIDGE_NETS)


def is_internal(ip):
    a = _addr(ip)
    if a is None:
        return True
    return ip in HOST_ADDRS or a.is_loopback or a.is_multicast or a.is_unspecified or is_bridge(ip)


def scope_of(ip):
    a = _addr(ip)
    if a is None or not a.is_global or detect.is_own(ip):
        return "lan"
    return "wan"


# ---------- sources ----------

def read_netdev():
    """Octets recus et envoyes par les cartes reseau physiques de l'hote."""
    rx = tx = 0
    try:
        with open("/proc/net/dev") as fh:
            lines = fh.readlines()[2:]
    except OSError:
        return None
    for line in lines:
        name, _, rest = line.partition(":")
        p = rest.split()
        if name.strip().startswith(VIRTUAL) or len(p) < 9:
            continue
        rx += int(p[0])
        tx += int(p[8])
    return rx, tx


def update_rate(now):
    v = read_netdev()
    if not v:
        return
    if NET["rx"] is not None and now > NET["t"]:
        dt = now - NET["t"]
        drx, dtx = max(0, v[0] - NET["rx"]), max(0, v[1] - NET["tx"])
        NET["rx_bps"], NET["tx_bps"] = drx / dt, dtx / dt
        NET["acc_rx"] += drx
        NET["acc_tx"] += dtx
        NET["acc_t"] += dt
    NET["rx"], NET["tx"], NET["t"] = v[0], v[1], now


def refresh_net():
    addrs, nets = set(), []
    for line in run(["ip", "-o", "addr", "show"]).splitlines():
        p = line.split()
        if len(p) < 4 or p[2] not in ("inet", "inet6"):
            continue
        try:
            iface = ipaddress.ip_interface(p[3])
        except ValueError:
            continue
        addrs.add(str(iface.ip))
        if p[1].startswith(BRIDGE_PREFIXES):
            nets.append(iface.network)
    if addrs:
        HOST_ADDRS.clear()
        HOST_ADDRS.update(addrs)
        BRIDGE_NETS[:] = nets


class _UnixHTTP(http.client.HTTPConnection):
    def __init__(self, path):
        super().__init__("localhost", timeout=5)
        self._path = path

    def connect(self):
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(5)
        s.connect(self._path)
        self.sock = s


def refresh_docker():
    if not os.path.exists(DOCKER_SOCK):
        INFO["docker"] = False
        return
    try:
        c = _UnixHTTP(DOCKER_SOCK)
        c.request("GET", "/containers/json")
        data = json.loads(c.getresponse().read())
        c.close()
        m = {}
        for ct in data:
            name = (ct.get("Names") or ["?"])[0].lstrip("/")
            for net in ((ct.get("NetworkSettings") or {}).get("Networks") or {}).values():
                for k in ("IPAddress", "GlobalIPv6Address"):
                    if net.get(k):
                        m[net[k]] = name
        CONTAINERS.clear()
        CONTAINERS.update(m)
        INFO["docker"] = True
    except Exception:
        INFO["docker"] = False


_USERS = re.compile(r'users:\(\("([^"]+)"')
_PAIR = re.compile(r"(\S+):(\d+)\s+(\S+):(\d+|\*)")
_RTT = re.compile(r"\brtt:([\d.]+)/")


def refresh_listeners():
    m = {}
    for line in run(["ss", "-H", "-ltnup"]).splitlines():
        p = line.split()
        pair = _PAIR.search(line)
        if not p or not pair:
            continue
        u = _USERS.search(line)
        m[(p[0], int(pair.group(2)))] = u.group(1) if u else ""
    if m:
        LISTENERS.clear()
        LISTENERS.update(m)


def parse_ss_established(text):
    """(ip distante, port distant, port local) -> (programme, latence en ms)."""
    out = {}
    merged = []
    for line in text.splitlines():
        if line[:1] in (" ", "\t") and merged:
            merged[-1] += " " + line.strip()
        else:
            merged.append(line)
    for line in merged:
        pair = _PAIR.search(line)
        if not pair or pair.group(4) == "*":
            continue
        u = _USERS.search(line)
        r = _RTT.search(line)
        key = (clean_ip(pair.group(3)), int(pair.group(4)), int(pair.group(2)))
        out[key] = (u.group(1) if u else "", float(r.group(1)) if r else None)
    return out


def parse_conntrack(text):
    out = []
    for line in text.splitlines():
        p = line.split()
        if len(p) < 6 or p[0] not in ("tcp", "udp"):
            continue
        state = p[3] if p[0] == "tcp" and "=" not in p[3] else ""
        src, dst, sp, dp, by = [], [], [], [], 0
        for t in p:
            if "=" not in t:
                continue
            k, v = t.split("=", 1)
            if k == "src":
                src.append(v)
            elif k == "dst":
                dst.append(v)
            elif k == "sport":
                sp.append(v)
            elif k == "dport":
                dp.append(v)
            elif k == "bytes" and v.isdigit():
                by += int(v)
        if len(src) < 2 or len(sp) < 2 or len(dp) < 2:
            continue
        try:
            out.append({"proto": p[0], "state": state, "o_src": src[0], "o_dst": dst[0],
                        "o_sp": int(sp[0]), "o_dp": int(dp[0]), "r_src": src[1],
                        "replied": "[UNREPLIED]" not in line, "bytes": by or None})
        except ValueError:
            continue
    return out


def classify(e, est):
    """Transforme une entree conntrack en connexion, ou None pour le trafic interne."""
    proto = e["proto"]
    o_src, o_dst = e["o_src"], e["o_dst"]
    if is_bridge(o_src) and o_src not in HOST_ADDRS:
        if is_internal(o_dst):
            return None
        app = CONTAINERS.get(o_src, "conteneur " + o_src)
        d = ("out", o_dst, e["o_dp"], e["o_sp"], app, None)
    elif o_src in HOST_ADDRS:
        if is_internal(o_dst):
            return None
        proc, rtt = est.get((o_dst, e["o_dp"], e["o_sp"]), ("", None))
        d = ("out", o_dst, e["o_dp"], e["o_sp"], proc or "hôte", rtt)
    else:
        a = _addr(o_src)
        if a is None or a.is_loopback or a.is_multicast or a.is_unspecified:
            return None
        proc, rtt = est.get((o_src, e["o_sp"], e["o_dp"]), ("", None))
        if e["r_src"] != o_dst and is_bridge(e["r_src"]):
            app = CONTAINERS.get(e["r_src"], "conteneur " + e["r_src"])
        elif o_dst in HOST_ADDRS:
            app = proc or LISTENERS.get((proto, e["o_dp"]), "") or "port %d" % e["o_dp"]
        else:
            return None  # diffusion ou trafic route ailleurs
        d = ("in", o_src, e["o_sp"], e["o_dp"], app, rtt)
    direction, ip, rport, lport, app, rtt = d
    sc = scope_of(ip)
    if sc == "lan" and not settings.get("log_lan"):
        return None
    if app.lower() in settings.get("ignore_apps") or lport in settings.get("ignore_ports"):
        return None
    return {"proto": proto, "ip": ip, "rport": rport, "lport": lport, "direction": direction,
            "scope": sc, "app": app, "state": e["state"], "replied": e["replied"],
            "rtt": rtt, "bytes": e["bytes"]}


def flows_from_ss(est):
    """Solution de repli sans conntrack : seulement les connexions TCP de l'hote."""
    out = []
    for (ip, rport, lport), (proc, rtt) in est.items():
        if is_internal(ip):
            continue
        direction = "in" if ("tcp", lport) in LISTENERS else "out"
        sc = scope_of(ip)
        if (sc == "lan" and not settings.get("log_lan")) or proc.lower() in settings.get("ignore_apps") \
                or lport in settings.get("ignore_ports"):
            continue
        out.append({"proto": "tcp", "ip": ip, "rport": rport, "lport": lport, "direction": direction,
                    "scope": sc, "app": proc or "port %d" % lport, "state": "ESTABLISHED",
                    "replied": True, "rtt": rtt, "bytes": None})
    return out


# ---------- boucle ----------

def is_live(f):
    return f["open"] and f["replied"] and (f["proto"] == "udp" or f["state"] == "ESTABLISHED")


def tick(now=None):
    now = now or time.time()
    est = parse_ss_established(run(["ss", "-H", "-O", "-tinp", "state", "established"]))
    INFO["ss_proc"] = any(v[0] for v in est.values())
    raw = run(["conntrack", "-L", "-f", "ipv4"]) + run(["conntrack", "-L", "-f", "ipv6"])
    entries = parse_conntrack(raw)
    INFO["conntrack"] = bool(entries)
    if entries:
        found = [c for c in (classify(e, est) for e in entries) if c]
    else:
        found = flows_from_ss(est)

    c = db.conn()
    seen = set()
    events = []
    with LOCK:
        for n in found:
            key = (n["proto"], n["ip"], n["rport"], n["lport"])
            seen.add(key)
            opened = n["proto"] == "udp" or n["state"] in OPEN_TCP
            f = FLOWS.get(key)
            if f is None:
                f = dict(n, first=now, last=now, open=opened)
                f["id"] = c.execute(
                    "INSERT INTO connections(proto,ip,rport,lport,direction,scope,app,state,first_seen,"
                    "last_seen,active,rtt,bytes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (n["proto"], n["ip"], n["rport"], n["lport"], n["direction"], n["scope"], n["app"],
                     n["state"], now, now, 1 if opened else 0, n["rtt"], n["bytes"])).lastrowid
                FLOWS[key] = f
                COUNTERS["new_in" if n["direction"] == "in" else "new_out"] += 1
                events.append(("flow", n["ip"], n["direction"], n["lport"], n["proto"], n["replied"]))
                if settings.get("rdns") and n["scope"] == "wan" and n["ip"] not in RDNS_CACHE:
                    try:
                        _rdns_q.put_nowait(n["ip"])
                    except queue.Full:
                        pass
                continue
            if n["replied"] and not f["replied"] and n["direction"] == "in":
                events.append(("reply", n["ip"], n["lport"]))
            f["last"] = now
            f["state"] = n["state"]
            f["replied"] = n["replied"]
            if n["bytes"] is not None:
                f["bytes"] = n["bytes"]
            if n["rtt"] is not None:
                f["rtt"] = n["rtt"]
            if n["app"] and f["app"].startswith(("port ", "hôte")):
                f["app"] = n["app"]
            if f["open"] and not opened:
                f["open"] = False
                _close(c, f)
        for key in [k for k in FLOWS if k not in seen]:
            f = FLOWS.pop(key)
            if f["open"]:
                f["open"] = False
                _close(c, f)
    c.commit()
    for ev in events:
        if ev[0] == "flow":
            detect.on_flow(ev[1], ev[2], ev[3], ev[4], ev[5], now)
        else:
            detect.on_reply(ev[1], ev[2], now)
    INFO["last_tick"] = now


def _close(c, f):
    c.execute("UPDATE connections SET active=0,last_seen=?,state=?,rtt=?,bytes=?,app=? WHERE id=?",
              (f["last"], f["state"], f["rtt"], f["bytes"], f["app"], f["id"]))


def flush_active():
    c = db.conn()
    with LOCK:
        rows = [(f["last"], f["state"], f["rtt"], f["bytes"], f["app"], f["id"])
                for f in FLOWS.values() if f["open"]]
    c.executemany("UPDATE connections SET last_seen=?,state=?,rtt=?,bytes=?,app=? WHERE id=?", rows)
    c.commit()


def snapshot():
    """Etat en direct : statistiques globales et un noeud par adresse distante."""
    now = time.time()
    with LOCK:
        live = [dict(f) for f in FLOWS.values() if is_live(f)]
    nodes = {}
    rtts, durs, n_in, n_out = [], [], 0, 0
    for f in live:
        n = nodes.setdefault(f["ip"], {"ip": f["ip"], "conns": 0, "apps": set(), "ports": set(),
                                       "in": 0, "out": 0, "rtt": [], "bytes": 0, "since": now,
                                       "scope": "lan" if detect.is_own(f["ip"]) else f["scope"]})
        n["conns"] += 1
        n["apps"].add(f["app"])
        n["ports"].add(f["lport"] if f["direction"] == "in" else f["rport"])
        n[f["direction"]] += 1
        n["bytes"] += f["bytes"] or 0
        n["since"] = min(n["since"], f["first"])
        if f["rtt"] is not None:
            n["rtt"].append(f["rtt"])
            rtts.append(f["rtt"])
        durs.append(now - f["first"])
        if f["direction"] == "in":
            n_in += 1
        else:
            n_out += 1
    out = []
    for n in nodes.values():
        n["apps"] = sorted(n["apps"])[:6]
        n["ports"] = sorted(n["ports"])[:8]
        n["rtt"] = round(sum(n["rtt"]) / len(n["rtt"]), 1) if n["rtt"] else None
        n["dir"] = "in" if n["in"] >= n["out"] else "out"
        n["host"] = RDNS_CACHE.get(n["ip"], "")
        out.append(n)
    stats = {"active": len(live), "ips": len(nodes), "inbound": n_in, "outbound": n_out,
             "avg_rtt": round(sum(rtts) / len(rtts), 1) if rtts else None,
             "avg_duration": round(sum(durs) / len(durs)) if durs else None,
             "rx_bps": round(NET["rx_bps"]), "tx_bps": round(NET["tx_bps"])}
    return stats, out


def _sample(now):
    stats, _ = snapshot()
    rx = NET["acc_rx"] / NET["acc_t"] if NET["acc_t"] else None
    tx = NET["acc_tx"] / NET["acc_t"] if NET["acc_t"] else None
    NET["acc_rx"] = NET["acc_tx"] = 0
    NET["acc_t"] = 0.0
    db.x("INSERT OR REPLACE INTO samples(ts,active,ips,new_in,new_out,rtt,http,flags,bans,rx,tx) "
         "VALUES(?,?,?,?,?,?,?,?,?,?,?)",
         (int(now // 60) * 60, stats["active"], stats["ips"], COUNTERS["new_in"], COUNTERS["new_out"],
          stats["avg_rtt"], COUNTERS["http"], detect.counter["flags"], COUNTERS["bans"], rx, tx))
    for k in COUNTERS:
        COUNTERS[k] = 0
    detect.counter["flags"] = 0


def _rdns_worker():
    while True:
        ip = _rdns_q.get()
        if ip in RDNS_CACHE:
            continue
        try:
            name = socket.gethostbyaddr(ip)[0]
        except Exception:
            name = ""
        if len(RDNS_CACHE) > 20000:
            RDNS_CACHE.clear()
        RDNS_CACHE[ip] = name


def loop():
    last_env = last_sample = last_purge = 0.0
    while True:
        t0 = time.time()
        try:
            if t0 - last_env > 30:
                refresh_net()
                refresh_docker()
                refresh_listeners()
                last_env = t0
            update_rate(t0)
            tick(t0)
            if t0 - last_sample >= 60:
                flush_active()
                _sample(t0)
                last_sample = t0
            if t0 - last_purge > 3600:
                db.purge(settings.get("retention_days"))
                last_purge = t0
        except Exception as ex:  # ne jamais arreter la collecte
            print("[collecteur] erreur :", repr(ex), flush=True)
        time.sleep(max(1.0, INTERVAL - (time.time() - t0)))


def start():
    threading.Thread(target=loop, daemon=True, name="collecteur").start()
    if True:
        for _ in range(2):
            threading.Thread(target=_rdns_worker, daemon=True, name="rdns").start()
