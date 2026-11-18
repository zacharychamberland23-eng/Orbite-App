"use strict";
(function () {
  const $ = (s) => document.querySelector(s);
  const NS = "http://www.w3.org/2000/svg";
  const STATUS_LABEL = { ok: "normal", bot: "robot", suspect: "suspect", banned: "banni", self: "toi" };
  const SEV_LABEL = { info: "info", low: "faible", medium: "moyenne", high: "grave" };
  let tab = "overview", live = null, timers = [], host = "", currentIp = null, ready = false;
  const BAN_LABEL = { ban: "bannie", unban: "débannie", restore: "ban restauré" };

  // ---------- utilitaires ----------
  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const k in attrs || {}) {
      if (k === "class") e.className = attrs[k];
      else if (k === "on") for (const ev in attrs.on) e.addEventListener(ev, attrs.on[ev]);
      else if (attrs[k] !== null && attrs[k] !== undefined) e.setAttribute(k, attrs[k]);
    }
    for (const kid of kids) if (kid !== null && kid !== undefined) e.append(kid.nodeType ? kid : String(kid));
    return e;
  }
  function s(tag, attrs) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs || {}) e.setAttribute(k, attrs[k]);
    return e;
  }
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const nf = new Intl.NumberFormat("fr-CA", { maximumFractionDigits: 1 });
  const num = (v) => (v === null || v === undefined ? "—" : nf.format(v));
  function dur(sec) {
    if (sec === null || sec === undefined) return "—";
    sec = Math.max(0, Math.round(sec));
    if (sec < 60) return sec + " s";
    if (sec < 3600) return Math.floor(sec / 60) + " min " + String(sec % 60).padStart(2, "0") + " s";
    if (sec < 86400) return Math.floor(sec / 3600) + " h " + String(Math.floor((sec % 3600) / 60)).padStart(2, "0");
    return Math.floor(sec / 86400) + " j " + Math.floor((sec % 86400) / 3600) + " h";
  }
  function bytes(b) {
    if (!b) return "—";
    const u = ["o", "ko", "Mo", "Go", "To"];
    let i = 0;
    while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
    return nf.format(b) + " " + u[i];
  }
  function when(ts) {
    const d = new Date(ts * 1000), now = new Date();
    const t = d.toLocaleTimeString("fr-CA", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    if (d.toDateString() === now.toDateString()) return t;
    return d.toLocaleDateString("fr-CA", { day: "numeric", month: "short" }) + " " + t;
  }
  const ms = (v) => (v === null || v === undefined ? "—" : nf.format(v) + " ms");

  async function api(path, opts) {
    const r = await fetch(path, Object.assign({ credentials: "same-origin" }, opts));
    if (r.status === 401 && path !== "/api/login") { showLogin(); throw new Error("401"); }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "Erreur " + r.status);
    return data;
  }
  const post = (path, body) => api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });

  function ipCell(ip, hostName) {
    const a = h("span", { class: "ip", title: "Voir l'historique de cette adresse", on: { click: () => openIp(ip) } }, ip);
    return hostName ? h("td", null, a, h("small", null, hostName)) : h("td", null, a);
  }
  function openIp(ip) { nav("#/ip/" + encodeURIComponent(ip)); }
  function rate(b) {
    if (b === null || b === undefined) return "—";
    const bits = b * 8;
    return bits >= 1e6 ? nf.format(bits / 1e6) + " Mbit/s" : nf.format(bits / 1e3) + " kbit/s";
  }
  function debounce(fn, t) { let id; return () => { clearTimeout(id); id = setTimeout(fn, t); }; }

  // ---------- theme ----------
  $("#theme").addEventListener("click", () => {
    setTheme(document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark");
    if (panelOpen() && S) renderSettings();
  });

  // ---------- connexion ----------
  function showLogin() {
    timers.forEach(clearInterval); timers = []; ready = false; S = null;
    document.body.classList.remove("panel-open");
    $("#app").hidden = true; $("#login").hidden = false;
    $("#l-pass").value = "";
  }
  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("#l-err").hidden = true;
    try {
      await post("/api/login", { user: $("#l-user").value, password: $("#l-pass").value });
      start();
    } catch (err) {
      $("#l-err").textContent = err.message; $("#l-err").hidden = false;
    }
  });
  $("#logout").addEventListener("click", async () => { try { await post("/api/logout"); } catch (e) {} showLogin(); });

  // ---------- navigation (le bouton Retour du navigateur suit les sections) ----------
  const ROUTES = { "": "overview", connexions: "connections", alertes: "alerts", bans: "bans", ip: "ip", lieu: "place" };
  const PATHS = { overview: "#/", connections: "#/connexions", alerts: "#/alertes", bans: "#/bans" };
  function nav(hash) {
    if (location.hash === hash) route(); else location.hash = hash;
  }
  function route() {
    if (!ready) return;
    const raw = location.hash.replace(/^#\/?/, ""), cut = raw.indexOf("?");
    const path = cut < 0 ? raw : raw.slice(0, cut), p = new URLSearchParams(cut < 0 ? "" : raw.slice(cut + 1)), parts = path.split("/");
    const name = ROUTES[parts[0]] || "overview";
    if (name === "connections") {
      $("#f-q").value = p.get("q") || ""; $("#f-active").value = p.get("active") === "0" ? "0" : "1";
      $("#f-dir").value = ["in", "out"].includes(p.get("dir")) ? p.get("dir") : "";
      $("#f-scope").value = ["wan", "lan"].includes(p.get("scope")) ? p.get("scope") : "";
    }
    if (name === "ip") { try { currentIp = decodeURIComponent(parts[1] || ""); } catch (e) { currentIp = ""; } }
    if (name === "place") currentPlace = { lat: p.get("lat") || "", lon: p.get("lon") || "" };
    setTab(name);
  }
  window.addEventListener("hashchange", route);
  function setTab(name) {
    tab = name;
    document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
    ["overview", "connections", "alerts", "bans", "ip", "place"].forEach((t) => { $("#tab-" + t).hidden = t !== name; });
    window.scrollTo(0, 0);
    if (name === "overview") { planet.resize(); drawCharts(); }
    if (name === "connections") loadConnections(true);
    if (name === "alerts") loadFlags();
    if (name === "bans") loadBans();
    if (name === "ip") loadIp();
    if (name === "place") loadPlace();
  }
  $("#tabs").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) nav(PATHS[b.dataset.tab]); });
  $("#home").addEventListener("click", (e) => { e.preventDefault(); nav("#/"); });

  // ---------- planete ----------
  const planet = (function () {
    const cv = $("#planet"), ctx = cv.getContext("2d"), tip = $("#tip");
    let W = 0, H = 0, dpr = 1, col = {}, nodes = new Map(), hover = null, mouse = null, t0 = performance.now();
    let groups = [0, 1, 2, 3].map(() => ({ n: 0, apps: "" })), maxSats = 180, animate = true, frozen = 0;
    // rotation de la Terre : automatique, ou a la main (reprise automatique apres 30 s sans y toucher)
    // ---- orientation de la Terre (quaternion corps -> vue) ----
    const qmul = (a, b) => [a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3], a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
                            a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1], a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0]];
    const qaxis = (x, y, z, ang) => { const s2 = Math.sin(ang / 2); return [Math.cos(ang / 2), x * s2, y * s2, z * s2]; };
    const qnorm = (q) => { const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1; return q.map((v) => v / n); };
    function qmat(q) {  // matrice corps -> vue
      const [w, x, y, z] = q;
      return [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
              2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
              2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)];
    }
    function qslerp(a, b, t) {
      let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
      if (d < 0) { b = b.map((v) => -v); d = -d; }
      if (d > 0.9995) return qnorm(a.map((v, i) => v + (b[i] - v) * t));
      const th = Math.acos(d), s0 = Math.sin((1 - t) * th) / Math.sin(th), s1 = Math.sin(t * th) / Math.sin(th);
      return a.map((v, i) => v * s0 + b[i] * s1);
    }
    const TILT = 0.41;
    const upright = (L) => qmul(qaxis(0, 0, 1, TILT), qaxis(0, 1, 0, -L));  // axe normal, longitude L face a nous
    let q = upright(Math.PI * 0.62), clouds = 0, lastT = 0, touched = -1e9, drag = null, lastDragMoved = false;
    let geoPts = [], home = null, geoHover = null, G_R = 0, G_cx = 0, G_cy = 0;
    let zoom = 1, FA = 1, pinned = null, pinnedPos = null, geoScreen = [];
    const hitGeo = (m) => { let best = null, bd = 1e9; geoScreen.forEach((o) => { const d = Math.hypot(m.x - o.p.x, m.y - o.p.y); if (d < o.r && d < bd) { bd = d; best = o.c; } }); return best; };
    const ZMIN = 0.6, ZMAX = 4, MAX_PX = 380000;
    const IDLE_MS = 30000;
    const ORBITS = [
      { label: "Entrantes", sub: "Internet", speed: 0.11, c: "in" },
      { label: "Sortantes", sub: "Internet", speed: -0.07, c: "out" },
      { label: "Réseau local", sub: "LAN", speed: 0.05, c: "lan" },
      { label: "Suspects", sub: "et bannis", speed: 0.09, c: "sus" },
    ];
    function rnd(n) { const x = Math.sin(n * 127.1) * 43758.5453; return x - Math.floor(x); }
    function hash(str) { let v = 2166136261; for (let i = 0; i < str.length; i++) { v ^= str.charCodeAt(i); v = Math.imul(v, 16777619); } return (v >>> 0) / 4294967295; }
    const stars = Array.from({ length: 190 }, (_, i) => ({ x: rnd(i * 3 + 1), y: rnd(i * 3 + 2), r: rnd(i * 3 + 3) * 1.0 + 0.3, w: rnd(i * 7 + 9) }));

    // ---- textures de la Terre (calculees une fois) ----
    const TW = 512, TH = 256;
    function h3(x, y, z, s) { let n = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483647) ^ Math.imul(s, 1274126177); n = Math.imul(n ^ (n >>> 13), 1274126177); return ((n ^ (n >>> 16)) >>> 0) / 4294967295; }
    function noise(x, y, z, s) {
      const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z), xf = x - xi, yf = y - yi, zf = z - zi;
      const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
      const L = (a, b, t) => a + (b - a) * t;
      return L(L(L(h3(xi, yi, zi, s), h3(xi + 1, yi, zi, s), u), L(h3(xi, yi + 1, zi, s), h3(xi + 1, yi + 1, zi, s), u), v),
               L(L(h3(xi, yi, zi + 1, s), h3(xi + 1, yi, zi + 1, s), u), L(h3(xi, yi + 1, zi + 1, s), h3(xi + 1, yi + 1, zi + 1, s), u), v), w);
    }
    function fbm(x, y, z, s, oct) { let a = 0, amp = 0.5, f = 1; for (let i = 0; i < oct; i++) { a += amp * noise(x * f, y * f, z * f, s + i); f *= 2.03; amp *= 0.5; } return a; }
    // carte terre/mer reelle (earth.js), adoucie pour des cotes lisses et des hauts-fonds
    const M = window.EARTH_MASK, MW = M.w, MH = M.h, raw = atob(M.bits), MASK = new Float32Array(MW * MH);
    for (let k = 0; k < MW * MH; k++) MASK[k] = (raw.charCodeAt(k >> 3) >> (7 - (k & 7))) & 1;
    function blur(src, r) {
      const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
      for (let j = 0; j < MH; j++) for (let i = 0; i < MW; i++) { let a = 0; for (let d = -r; d <= r; d++) a += src[j * MW + ((i + d + MW) % MW)]; tmp[j * MW + i] = a / (2 * r + 1); }
      for (let j = 0; j < MH; j++) for (let i = 0; i < MW; i++) { let a = 0; for (let d = -r; d <= r; d++) a += tmp[Math.min(MH - 1, Math.max(0, j + d)) * MW + i]; out[j * MW + i] = a / (2 * r + 1); }
      return out;
    }
    const COAST = blur(MASK, 1), SHELF = blur(MASK, 6);
    const ELEV = new Float32Array(TW * TH), CLOUD = new Float32Array(TW * TH), CITY = new Float32Array(TW * TH);
    for (let j = 0; j < TH; j++) {
      const lat = (0.5 - (j + 0.5) / TH) * Math.PI, cl = Math.cos(lat), sl = Math.sin(lat);
      for (let i = 0; i < TW; i++) {
        const lon = ((i + 0.5) / TW) * Math.PI * 2, x = cl * Math.cos(lon), y = sl, z = cl * Math.sin(lon), k = j * TW + i;
        ELEV[k] = fbm(x * 2.2 + 5, y * 2.2 + 5, z * 2.2 + 5, 11, 5);
        const c = fbm(x * 3.2, y * 6.5, z * 3.2, 53, 4);
        CLOUD[k] = Math.max(0, Math.min(1, (c - 0.53) * 3.0)) * (0.5 + 0.5 * Math.abs(sl));
        const mk = Math.min(MH - 1, Math.floor((j + 0.5) / TH * MH)) * MW + Math.min(MW - 1, Math.floor((i + 0.5) / TW * MW));
        CITY[k] = MASK[mk] && Math.abs(lat) < 1.1 && rnd(k * 1.7 + 3) > 0.9 ? rnd(k + 11) : 0;
      }
    }
    // ---- rendu de la sphere, pixel par pixel ----
    const gcv = document.createElement("canvas"), gctx = gcv.getContext("2d");
    let img = null, lastGlobe = -1, lastRender = 0, lastBox = "", qAdapt = 1;
    const Lx = -0.55, Ly = 0.42, Lz = 0.72, Ln = Math.hypot(Lx, Ly, Lz), lx = Lx / Ln, ly = Ly / Ln, lz = Lz / Ln;
    const hx = lx, hy = ly, hz = lz + 1, hn = Math.hypot(hx, hy, hz), Hx = hx / hn, Hy = hy / hn, Hz = hz / hn;
    function renderGlobe(m, crot, R, cx, cy, x0, y0, bw, bh, qd) {
      if (!img || img.width !== bw || img.height !== bh) { gcv.width = bw; gcv.height = bh; img = gctx.createImageData(bw, bh); }
      const d = img.data, edge = 1.5 / (R * qd);
      // m est corps -> vue ; sa transposee donne vue -> corps
      const a0 = m[0], a1 = m[3], a2 = m[6], b0 = m[1], b1 = m[4], b2 = m[7], c0 = m[2], c1 = m[5], c2 = m[8];
      for (let j = 0; j < bh; j++) {
        const Ys = (cy - (y0 + (j + 0.5) / qd)) / R;
        for (let i = 0; i < bw; i++) {
          const o = (j * bw + i) * 4, Xs = (x0 + (i + 0.5) / qd - cx) / R, r2 = Xs * Xs + Ys * Ys;
          if (r2 > (1 + edge) * (1 + edge)) { d[o + 3] = 0; continue; }
          const dist = Math.sqrt(r2), aa = Math.max(0, Math.min(1, (1 - dist) * R * qd + 0.5));
          if (aa <= 0) { d[o + 3] = 0; continue; }
          const sc = dist > 1 ? 1 / dist : 1, X = Xs * sc, Y = Ys * sc, Z = Math.sqrt(Math.max(0, 1 - X * X - Y * Y));
          const bx = a0 * X + a1 * Y + a2 * Z, by = b0 * X + b1 * Y + b2 * Z, bz = c0 * X + c1 * Y + c2 * Z;
          const lat = Math.asin(Math.max(-1, Math.min(1, by))), lon = Math.atan2(bx, bz);
          let u = lon / (Math.PI * 2); u -= Math.floor(u);
          let uc = (lon + crot) / (Math.PI * 2); uc -= Math.floor(uc);
          const vv = 0.5 - lat / Math.PI;
          // carte reelle, echantillonnage bilineaire
          const fu = u * MW - 0.5, i0 = Math.floor(fu), fx = fu - i0, ia = (i0 + MW) % MW, ib = (i0 + 1) % MW;
          const fv = Math.max(0, Math.min(MH - 1.001, vv * MH - 0.5)), j0 = Math.floor(fv), fy = fv - j0, j1 = Math.min(MH - 1, j0 + 1);
          const land = Math.max(0, Math.min(1, ((COAST[j0 * MW + ia] * (1 - fx) + COAST[j0 * MW + ib] * fx) * (1 - fy) + (COAST[j1 * MW + ia] * (1 - fx) + COAST[j1 * MW + ib] * fx) * fy - 0.42) / 0.16));
          const shelf = SHELF[j0 * MW + ia];
          const tj = Math.min(TH - 1, Math.floor(vv * TH)), ti = tj * TW + Math.floor(u * TW), tc = tj * TW + Math.floor(uc * TW);
          const e = ELEV[ti];
          const diff = X * lx + Y * ly + Z * lz, day = Math.max(0, Math.min(1, diff * 1.6 + 0.12));
          const ice = Math.abs(lat) > 1.2 + (e - 0.5) * 0.35 || (land > 0.5 && Math.abs(lat) > 1.08 + (e - 0.5) * 0.4);
          let r, g, b;
          const sh = Math.min(1, shelf * 1.6);
          const or = 6 + 24 * sh, og = 26 + 62 * sh, ob = 58 + 72 * sh;
          let lr, lg, lb;
          const dry = Math.max(0, Math.min(1, 1 - Math.abs(lat - 0.4) * 2.2)) * 0.6 + Math.max(0, Math.min(1, 1 - Math.abs(lat + 0.4) * 2.2)) * 0.5;
          const hh = Math.max(0, Math.min(1, (e - 0.35) * 2.2));
          if (hh > 0.62) { const q = Math.min(1, (hh - 0.62) / 0.3); lr = 120 + 90 * q; lg = 112 + 100 * q; lb = 92 + 130 * q; }
          else { lr = 58 + 100 * dry + 30 * hh; lg = 98 + 50 * dry + 18 * hh; lb = 52 + 40 * dry + 10 * hh; }
          if (ice) { r = 226; g = 234; b = 242; }
          else { r = or + (lr - or) * land; g = og + (lg - og) * land; b = ob + (lb - ob) * land; }
          const lit = 0.06 + 0.94 * day;
          r *= lit; g *= lit; b *= lit;
          if (land < 1 && !ice) {
            const sp = Math.pow(Math.max(0, X * Hx + Y * Hy + Z * Hz), 90) * 95 * (1 - land);
            r += sp; g += sp; b += sp * 0.95;
          }
          if (day < 0.35 && land > 0.5 && CITY[ti]) {
            const ni = (0.35 - day) / 0.35 * CITY[ti] * 230;
            r += ni; g += ni * 0.72; b += ni * 0.35;
          }
          const c = CLOUD[tc];
          if (c) { const cw = 255 * (0.08 + 0.92 * day); r += (cw - r) * c * 0.8; g += (cw - g) * c * 0.8; b += (cw - b) * c * 0.8; }
          const rim = Math.pow(1 - Z, 2.6) * (0.25 + 0.9 * Math.max(0, diff + 0.2));
          r += 80 * rim; g += 150 * rim; b += 255 * rim;
          d[o] = r > 255 ? 255 : r; d[o + 1] = g > 255 ? 255 : g; d[o + 2] = b > 255 ? 255 : b; d[o + 3] = aa * 255;
        }
      }
      gctx.putImageData(img, 0, 0);
    }
    // latitude/longitude reelles -> position a l'ecran (meme projection que renderGlobe)
    let OM = qmat(q);
    function project(latDeg, lonDeg, g) {
      const lat = latDeg * Math.PI / 180, lb = ((lonDeg + 180) / 360) * Math.PI * 2;
      const bx = Math.cos(lat) * Math.sin(lb), by = Math.sin(lat), bz = Math.cos(lat) * Math.cos(lb);
      const X = OM[0] * bx + OM[1] * by + OM[2] * bz, Y = OM[3] * bx + OM[4] * by + OM[5] * bz, Z = OM[6] * bx + OM[7] * by + OM[8] * bz;
      return { x: g.cx + X * g.R, y: g.cy - Y * g.R, z: Z };
    }

    function theme() {
      const dark = document.documentElement.getAttribute("data-theme") === "dark";
      col = { in: css("--r-in"), out: css("--r-out"), lan: css("--r-lan"), sus: css("--hud"), text: css("--text"),
              muted: css("--muted"), bg: css("--space"), dark };
    }
    function resize() {
      const r = cv.parentElement.getBoundingClientRect();
      if (!r.width) return;
      dpr = Math.min(2, window.devicePixelRatio || 1);
      W = r.width; H = r.height;
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
      lastBox = "";
    }
    const orbitOf = (n) => (n.status === "suspect" || n.status === "banned" ? 3 : n.scope === "lan" ? 2 : n.dir === "in" ? 0 : 1);
    function setGeo(locs, h0) {
      const cells = new Map();
      (live && live.nodes || []).forEach((n) => {
        const g = locs[n.ip];
        if (!g) return;
        const key = Math.round(g[0] * 2) / 2 + "," + Math.round(g[1] * 2) / 2;
        let c = cells.get(key);
        if (!c) { c = { key, lat: g[0], lon: g[1], cc: g[2], city: g[3], ips: [], conns: 0, worst: 0, k: orbitOf(n) }; cells.set(key, c); }
        c.ips.push(n.ip); c.conns += n.conns;
        const w = n.status === "banned" ? 3 : n.status === "suspect" ? 2 : n.status === "self" ? -1 : n.status === "bot" ? 1 : 0;
        if (w > c.worst) { c.worst = w; c.k = orbitOf(n); }
      });
      geoPts = [...cells.values()];
      home = h0 ? { lat: h0[0], lon: h0[1], city: h0[3], cc: h0[2] } : null;
    }
    function set(list) {
      const seen = new Set(), g = [0, 1, 2, 3].map(() => ({ n: 0, apps: new Map(), banned: 0 }));
      list.forEach((n) => {
        const k = orbitOf(n);
        g[k].n += n.conns; if (n.status === "banned") g[k].banned++;
        n.apps.forEach((a) => g[k].apps.set(a, (g[k].apps.get(a) || 0) + n.conns));
      });
      groups = g.map((x, k) => {
        const apps = [...x.apps.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map((a) => a[0]).join(", ");
        return { n: x.n, apps: k === 3 && x.banned ? x.banned + " bannie" + (x.banned > 1 ? "s" : "") + (apps ? " · " + apps : "") : apps };
      });
      list.slice(0, maxSats).forEach((n) => {
        seen.add(n.ip);
        let o = nodes.get(n.ip);
        if (!o) { o = { a0: hash(n.ip) * Math.PI * 2, j: hash(n.ip + "j"), alpha: 0, x: 0, y: 0 }; nodes.set(n.ip, o); }
        o.d = n; o.k = orbitOf(n); o.gone = false;
      });
      nodes.forEach((o, ip) => { if (!seen.has(ip)) o.gone = true; });
    }
    function geom() {
      const narrow = W < 700;
      const R = (narrow ? Math.min(W * 0.2, H * 0.17) : Math.min(H * 0.185, W * 0.15, 150)) * zoom;
      const cx = narrow ? W / 2 : W * 0.54, cy = narrow ? H * 0.52 : H * 0.47;
      const wide = Math.max(R * 1.6, Math.min(R * 3.7, narrow ? W * 0.47 : Math.min(cx, W - cx) - 14));
      return { narrow, R, cx, cy, o: [
        { rx: R * 1.42, ry: R * 1.42, rot: 0, flat: false, at: -0.62 },
        { rx: R * 1.98, ry: R * 1.98, rot: 0, flat: false, at: -1.42 },
        { rx: wide, ry: R * 0.5, rot: -0.035, flat: true, at: Math.PI },
        { rx: Math.min(R * 2.6, wide), ry: R * 0.8, rot: 0.74, flat: true, at: 0.1 },
      ] };
    }
    function pt(g, k, a) {
      const o = g.o[k], px = o.rx * Math.cos(a), py = o.ry * Math.sin(a), c = Math.cos(o.rot), sn = Math.sin(o.rot);
      return { x: g.cx + px * c - py * sn, y: g.cy + px * sn + py * c };
    }
    const ringCol = (k) => col[ORBITS[k].c];
    function orbit(g, k, from, to) {
      const o = g.o[k], c = ringCol(k);
      ctx.save();
      ctx.beginPath(); ctx.ellipse(g.cx, g.cy, o.rx, o.ry, o.rot, from, to);
      if (col.dark) { ctx.shadowColor = c; ctx.shadowBlur = 8; }
      ctx.strokeStyle = c; ctx.lineWidth = k === 3 ? 1.3 : 1.1; ctx.globalAlpha = (k === 3 ? 0.95 : 0.75) * FA;
      if (k === 2) ctx.setLineDash([2, 5]);
      ctx.stroke(); ctx.restore();
    }
    function globe(g, t) {
      const { cx, cy, R } = g;
      // atmosphere
      const glow = ctx.createRadialGradient(cx, cy, R * 0.92, cx, cy, R * 1.32);
      glow.addColorStop(0, col.dark ? "rgba(96,165,250,.45)" : "rgba(59,130,246,.30)");
      glow.addColorStop(0.35, col.dark ? "rgba(56,130,246,.16)" : "rgba(59,130,246,.10)");
      glow.addColorStop(1, "rgba(59,130,246,0)");
      ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(cx, cy, R * 1.32, 0, Math.PI * 2); ctx.fill();
      const x0 = Math.max(0, Math.floor(cx - R)), y0 = Math.max(0, Math.floor(cy - R));
      const x1 = Math.min(W, Math.ceil(cx + R)), y1 = Math.min(H, Math.ceil(cy + R));
      if (x1 > x0 && y1 > y0) {
        let qd = Math.min(dpr, 1.5);
        const area = (x1 - x0) * (y1 - y0);
        if (area * qd * qd > MAX_PX) qd = Math.sqrt(MAX_PX / area);
        qd *= qAdapt;  // qualite adaptee a la vitesse de la machine
        const bw = Math.max(1, Math.ceil((x1 - x0) * qd)), bh = Math.max(1, Math.ceil((y1 - y0) * qd));
        const box = [x0, y0, x1, y1, R.toFixed(2), cx.toFixed(1), cy.toFixed(1)].join(",");
        const key = q[0] * 1e4 + q[1] * 3e3 + q[2] * 7e3 + q[3] * 11e3 + clouds * 3e2, now = performance.now();
        const changed = box !== lastBox || Math.abs(key - lastGlobe) > 2;
        const every = zoom > 1.5 ? 50 : 33;  // rotation auto : 20 a 30 images/s suffisent
        if (changed && (box !== lastBox || drag || now - lastRender > every)) {
          renderGlobe(OM, clouds, R, cx, cy, x0, y0, bw, bh, qd);
          const ms = performance.now() - now;
          const budget = zoom > 1.5 ? 20 : 14;
          if (ms > budget) qAdapt = Math.max(0.45, qAdapt * 0.9); else if (ms < budget / 2) qAdapt = Math.min(1, qAdapt * 1.04);
          lastGlobe = key; lastBox = box; lastRender = now;
        }
        ctx.drawImage(gcv, 0, 0, gcv.width, gcv.height, x0, y0, bw / qd, bh / qd);
      }
      if (grab) {
        grab.style.left = Math.max(0, cx - R) + "px"; grab.style.top = Math.max(0, cy - R) + "px";
        grab.style.width = (Math.min(W, cx + R) - Math.max(0, cx - R)) + "px"; grab.style.height = (Math.min(H, cy + R) - Math.max(0, cy - R)) + "px";
        grab.style.borderRadius = R * 2 < Math.min(W, H) ? "50%" : "0";
      }
      // fin liseré lumineux cote soleil
      ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, R + 0.5, Math.PI * 0.85, Math.PI * 1.65);
      ctx.strokeStyle = "rgba(186,230,253,.55)"; ctx.lineWidth = 1.2; ctx.stroke(); ctx.restore();
    }
    function projectAlt(latDeg, lonDeg, g, h) {
      const p = project(latDeg, lonDeg, g);
      return { x: g.cx + (p.x - g.cx) * (1 + h), y: g.cy + (p.y - g.cy) * (1 + h), z: p.z };
    }
    const cellColor = (c) => (c.worst >= 2 ? col.sus : c.worst === -1 ? col.lan : col[ORBITS[c.k].c]);
    function beacon(c, g, t, strength) {
      const base = project(c.lat, c.lon, g);
      if (base.z <= 0.02) return;
      const top = projectAlt(c.lat, c.lon, g, Math.min(1.1, 0.8 / Math.sqrt(zoom)) + 0.15), color = cellColor(c);
      const fade = Math.min(1, (base.z - 0.02) * 5) * strength;
      const grad = ctx.createLinearGradient(base.x, base.y, top.x, top.y);
      grad.addColorStop(0, color); grad.addColorStop(0.75, color); grad.addColorStop(1, "rgba(0,0,0,0)");
      ctx.save(); ctx.lineCap = "round"; ctx.strokeStyle = grad;
      ctx.globalCompositeOperation = col.dark ? "lighter" : "source-over";
      const flick = 0.85 + 0.15 * Math.sin(t * 7);
      [[22, 0.10], [12, 0.2], [6, 0.5 * flick], [3, 0.95]].forEach(([w, a]) => {
        ctx.globalAlpha = a * fade; ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo(base.x, base.y); ctx.lineTo(top.x, top.y); ctx.stroke();
      });
      ctx.globalAlpha = 0.95 * fade; ctx.strokeStyle = "rgba(255,255,255,.9)"; ctx.lineWidth = 1.4;
      const mid = { x: base.x + (top.x - base.x) * 0.7, y: base.y + (top.y - base.y) * 0.7 };
      ctx.beginPath(); ctx.moveTo(base.x, base.y); ctx.lineTo(mid.x, mid.y); ctx.stroke();
      for (let i = 0; i < 4; i++) {  // particules qui montent dans le faisceau
        const f = (t * 0.5 + i / 4) % 1;
        ctx.globalAlpha = (1 - f) * 0.9 * fade; ctx.fillStyle = color;
        ctx.beginPath(); ctx.arc(base.x + (top.x - base.x) * f, base.y + (top.y - base.y) * f, 2.2, 0, Math.PI * 2); ctx.fill();
      }
      const pq = (t * 0.9) % 1;
      ctx.globalAlpha = (1 - pq) * 0.8 * fade; ctx.strokeStyle = color; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.ellipse(base.x, base.y, 4 + pq * 16, (4 + pq * 16) * Math.max(0.3, base.z), 0, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = fade; ctx.fillStyle = "#fff";  // socle lumineux
      ctx.beginPath(); ctx.arc(base.x, base.y, 2.6, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
    function geoLayer(g, t) {
      geoHover = null; pinnedPos = null; geoScreen = [];
      const pts = [];
      geoPts.forEach((c) => {
        const p = project(c.lat, c.lon, g);
        if (p.z <= 0.04) return;
        pts.push({ c, p });
      });
      pts.sort((a, b) => a.p.z - b.p.z);
      pts.forEach(({ c, p }) => {
        const col0 = cellColor(c);
        const a = Math.min(1, (p.z - 0.04) * 4), size = 2.4 + Math.min(4, Math.log2(1 + c.conns) * 1.0);
        ctx.globalAlpha = a;
        ctx.shadowColor = col0; ctx.shadowBlur = 8;
        ctx.beginPath(); ctx.arc(p.x, p.y, size, 0, Math.PI * 2); ctx.fillStyle = col0; ctx.fill();
        ctx.shadowBlur = 0;
        if (c.worst >= 2) {
          const q = (Math.sin(t * 3 + c.lat) + 1) / 2;
          ctx.globalAlpha = a * 0.5 * (1 - q); ctx.beginPath(); ctx.arc(p.x, p.y, size + 2 + q * 6, 0, Math.PI * 2); ctx.strokeStyle = col.sus; ctx.lineWidth = 1; ctx.stroke();
        }
        geoScreen.push({ c, p, r: size + 5 });
        if (mouse && !drag && Math.hypot(mouse.x - p.x, mouse.y - p.y) < size + 5) geoHover = { c, p };
        if (pinned && c.key === pinned) pinnedPos = { c, p };
      });
      const pc = pinned ? geoPts.find((c) => c.key === pinned) : null;
      if (pc) beacon(pc, g, t, 1);
      if (geoHover && geoHover.c && geoHover.c.key !== pinned) beacon(geoHover.c, g, t, 0.55);
      if (home) {
        const p = project(home.lat, home.lon, g);
        if (p.z > 0.04) {
          const q = (t * 0.8) % 1;
          ctx.globalAlpha = Math.min(1, (p.z - 0.04) * 4);
          ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI * 2); ctx.fillStyle = "#ffffff"; ctx.fill();
          ctx.globalAlpha *= 1 - q; ctx.beginPath(); ctx.arc(p.x, p.y, 3 + q * 12, 0, Math.PI * 2); ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 1.2; ctx.stroke();
          if (mouse && !drag && Math.hypot(mouse.x - p.x, mouse.y - p.y) < 8) geoHover = { home: true, p };
        }
      }
      ctx.globalAlpha = 1;
    }
    function sat(o, t) {
      const st = o.d.status, base = o.alpha * (o.front ? 1 : 0.4) * FA, c = ringCol(o.k);
      ctx.globalAlpha = base;
      if (st === "suspect" || st === "banned") {
        const p = (Math.sin(t * 3 + o.j * 10) + 1) / 2;
        ctx.beginPath(); ctx.arc(o.x, o.y, o.size + 3 + p * 5, 0, Math.PI * 2);
        ctx.strokeStyle = col.sus; ctx.lineWidth = 1; ctx.globalAlpha = base * 0.5 * (1 - p * 0.7); ctx.stroke();
        ctx.globalAlpha = base;
      }
      ctx.beginPath(); ctx.arc(o.x, o.y, o.size, 0, Math.PI * 2);
      if (col.dark) { ctx.shadowColor = c; ctx.shadowBlur = 7; }
      if (st === "bot") { ctx.fillStyle = col.bg; ctx.fill(); ctx.strokeStyle = c; ctx.lineWidth = 1.6; ctx.stroke(); }
      else if (st === "banned") { ctx.fillStyle = col.text; ctx.fill(); ctx.strokeStyle = col.sus; ctx.lineWidth = 2; ctx.stroke(); }
      else { ctx.fillStyle = c; ctx.fill(); }
      ctx.shadowBlur = 0;
      if (hover === o) { ctx.beginPath(); ctx.arc(o.x, o.y, o.size + 4.5, 0, Math.PI * 2); ctx.strokeStyle = col.text; ctx.lineWidth = 1.2; ctx.stroke(); }
      ctx.globalAlpha = 1;
    }
    function callout(g, k) {
      const p = pt(g, k, g.o[k].at), gr = groups[k], small = g.narrow, c = ringCol(k);
      ctx.globalAlpha = FA;
      ctx.beginPath(); ctx.arc(p.x, p.y, small ? 6 : 8.5, 0, Math.PI * 2); ctx.fillStyle = c; ctx.fill();
      ctx.strokeStyle = col.bg; ctx.lineWidth = 2; ctx.stroke();
      const f = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";
      const numF = "700 " + (small ? 17 : 24) + "px " + f, labF = (small ? 12 : 15) + "px " + f, subF = "italic 11.5px " + f;
      const label = ORBITS[k].label + (small ? "" : " (" + ORBITS[k].sub + ")");
      ctx.font = labF; let w = ctx.measureText(label).width;
      if (!small && gr.apps) { ctx.font = subF; w = Math.max(w, ctx.measureText(gr.apps).width); }
      let x, y, align = "left";
      if (k === 2) { x = Math.max(12, p.x - 10); y = p.y + (small ? 26 : 38); }
      else { x = p.x + (small ? 12 : 18); y = p.y - 4; if (x + w > W - 10) { x = p.x - (small ? 12 : 18); align = "right"; } }
      ctx.textAlign = align; ctx.textBaseline = "alphabetic";
      ctx.lineJoin = "round"; ctx.strokeStyle = col.bg; ctx.lineWidth = 4;
      const put = (txt, font, color, yy) => { ctx.font = font; ctx.strokeText(txt, x, yy); ctx.fillStyle = color; ctx.fillText(txt, x, yy); };
      put(num(gr.n), numF, c, y);
      put(label, labF, col.text, y + (small ? 15 : 20));
      if (!small && gr.apps) put(gr.apps, subF, col.muted, y + 37);
      ctx.globalAlpha = 1;
    }
    function frame(now) {
      requestAnimationFrame(frame);
      if (tab !== "overview" || !W || document.hidden) return;
      if (!animate) { if (!frozen) frozen = now; } else if (frozen) { t0 += now - frozen; frozen = 0; }
      const t = ((frozen || now) - t0) / 1000, g = geom();
      const dt = lastT ? Math.min(0.1, t - lastT) : 0; lastT = t;
      const idle = performance.now() - touched > IDLE_MS;
      if (idle && !drag) {
        // tourne sur son propre axe, puis se redresse en douceur vers l'axe normal sans changer de face
        q = qnorm(qmul(q, qaxis(0, 1, 0, dt * 0.045 / Math.sqrt(zoom))));
        const m0 = qmat(q), L = Math.atan2(m0[6], m0[8]);  // longitude face a nous
        q = qnorm(qslerp(q, upright(L), Math.min(1, dt * 1.2)));
      }
      OM = qmat(q);
      clouds += dt * 0.02;
      G_R = g.R; G_cx = g.cx; G_cy = g.cy;
      FA = Math.max(0, Math.min(1, (2.2 - zoom) / 0.7));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = col.dark ? "#ffffff" : "#3f3f46";
      stars.forEach((s, i) => { ctx.globalAlpha = (col.dark ? 0.15 : 0.08) + (col.dark ? 0.65 : 0.2) * ((Math.sin(t * (0.3 + s.w) + i) + 1) / 2); ctx.beginPath(); ctx.arc(s.x * W, s.y * H, s.r, 0, Math.PI * 2); ctx.fill(); });
      ctx.globalAlpha = 1;
      const list = [];
      nodes.forEach((o, ip) => {
        o.alpha += ((o.gone ? 0 : 1) - o.alpha) * 0.08;
        if (o.gone && o.alpha < 0.03) { nodes.delete(ip); return; }
        const a = o.a0 + t * ORBITS[o.k].speed * (0.75 + o.j * 0.5), p = pt(g, o.k, a);
        o.x = p.x; o.y = p.y; o.front = !g.o[o.k].flat || Math.sin(a) > 0;
        o.size = 2.6 + Math.min(4.2, Math.log2(1 + o.d.conns) * 1.15);
        list.push(o);
      });
      if (mouse && !drag && FA > 0.3) {
        let best = null, bd = 12;
        list.forEach((o) => { const d = Math.hypot(o.x - mouse.x, o.y - mouse.y) - o.size; if (d < bd && (o.front || Math.hypot(o.x - g.cx, o.y - g.cy) > g.R)) { bd = d; best = o; } });
        hover = best;
      } else hover = null;
      if (FA > 0.01) [0, 1, 2, 3].forEach((k) => orbit(g, k, 0, Math.PI * 2));
      if (FA > 0.01) list.filter((o) => !o.front).forEach((o) => sat(o, t));
      globe(g, t);
      if (geoPts.length || home) geoLayer(g, t);
      if (FA > 0.01) [2, 3].forEach((k) => orbit(g, k, 0, Math.PI));
      if (hover) { ctx.beginPath(); ctx.moveTo(hover.x, hover.y); ctx.lineTo(g.cx, g.cy); ctx.strokeStyle = col.text; ctx.globalAlpha = 0.35; ctx.lineWidth = 1; ctx.setLineDash([3, 4]); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1; }
      if (FA > 0.01) list.filter((o) => o.front).forEach((o) => sat(o, t));
      if (FA > 0.01) [0, 1, 2, 3].forEach((k) => callout(g, k));
      showTip();
    }
    function showTip() {
      const onGlobe = mouse && Math.hypot(mouse.x - G_cx, mouse.y - G_cy) < G_R * 1.03;
      const geoShow = !hover && !drag ? (geoHover || pinnedPos) : null;
      if (geoShow) {
        cv.style.cursor = geoHover ? "pointer" : onGlobe ? "grab" : "default";
        tip.textContent = "";
        if (geoShow.home) tip.append(h("div", null, h("b", null, "Ton serveur"), home.city ? " · " + home.city : ""));
        else {
          const c = geoShow.c, isPinned = c.key === pinned;
          tip.append(h("div", null, h("b", null, [c.city, c.cc].filter(Boolean).join(", ") || "Lieu inconnu"), isPinned ? h("span", { class: "muted" }, " · épinglé") : null));
          tip.append(h("div", null, c.ips.length + " adresse" + (c.ips.length > 1 ? "s" : "") + " · " + c.conns + " connexion" + (c.conns > 1 ? "s" : "")));
          c.ips.slice(0, 5).forEach((ip) => tip.append(h("div", { class: "mono muted" }, ip)));
          if (c.ips.length > 5) tip.append(h("div", { class: "muted" }, "et " + (c.ips.length - 5) + " autre(s)"));
          tip.append(h("div", { class: "tiphint" }, (isPinned ? "" : "Clic : épingler · ") + "Double-clic : " + (c.ips.length === 1 ? "ouvrir la fiche" : "voir les adresses")));
        }
        tip.hidden = false;
        tip.style.left = Math.max(8, Math.min(W - tip.offsetWidth - 8, geoShow.p.x + 12)) + "px";
        tip.style.top = Math.max(8, Math.min(H - tip.offsetHeight - 8, geoShow.p.y + 12)) + "px";
        return;
      }
      if (!hover) { tip.hidden = true; cv.style.cursor = drag ? "grabbing" : onGlobe ? "grab" : "default"; return; }
      const d = hover.d;
      cv.style.cursor = "pointer";
      tip.textContent = "";
      tip.append(h("div", null, h("b", { class: "mono" }, d.ip), " ", h("span", { class: "muted" }, "· " + STATUS_LABEL[d.status])));
      if (d.host) tip.append(h("div", { class: "muted" }, d.host));
      tip.append(h("div", null, d.conns + " connexion" + (d.conns > 1 ? "s" : "") + " · " + (d.dir === "in" ? "entrante" : "sortante") + (d.scope === "lan" ? " · réseau local" : "")));
      tip.append(h("div", null, "App : " + d.apps.join(", ")));
      tip.append(h("div", null, "Ports : " + d.ports.join(", ")));
      tip.append(h("div", null, "Latence : " + ms(d.rtt) + " · depuis " + dur(Date.now() / 1000 - d.since)));
      tip.hidden = false;
      const tw = tip.offsetWidth, th = tip.offsetHeight;
      tip.style.left = Math.max(8, Math.min(W - tw - 8, hover.x + 14)) + "px";
      tip.style.top = Math.max(8, Math.min(H - th - 8, hover.y + 14)) + "px";
    }
    const card = cv.parentElement, grab = document.createElement("div");
    grab.className = "globe-grab"; card.appendChild(grab);
    const pos = (e) => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    card.addEventListener("pointermove", (e) => {
      mouse = pos(e);
      if (!drag) return;
      const dx = mouse.x - drag.x, dy = mouse.y - drag.y;
      drag.x = mouse.x; drag.y = mouse.y;
      if (Math.abs(mouse.x - drag.x0) + Math.abs(mouse.y - drag.y0) > 4) drag.moved = true;
      const k = 1 / Math.max(40, G_R);
      // gauche-droite : autour de l'axe vertical de l'ecran ; haut-bas : autour de l'axe horizontal
      q = qnorm(qmul(qmul(qaxis(0, 1, 0, dx * k), qaxis(1, 0, 0, dy * k)), q));
      touched = performance.now();
    });
    card.addEventListener("pointerdown", (e) => {
      const p = pos(e);
      if (hover || Math.hypot(p.x - G_cx, p.y - G_cy) > G_R * 1.03) return;
      drag = { x: p.x, y: p.y, x0: p.x, y0: p.y, moved: false };
      touched = performance.now();
      try { card.setPointerCapture(e.pointerId); } catch (err) {}
    });
    const end = () => {
      if (!drag) return;
      lastDragMoved = drag.moved; drag = null; touched = performance.now();
    };
    card.addEventListener("pointerup", end); card.addEventListener("pointercancel", end);
    card.addEventListener("pointerleave", () => { if (!drag) mouse = null; });
    card.addEventListener("click", (e) => {
      if (e.target.closest(".zoombar")) return;
      if (lastDragMoved) { lastDragMoved = false; return; }
      if (hover) return openIp(hover.d.ip);
      const c = hitGeo(pos(e));
      if (c) { pinned = c.key; touched = performance.now(); return; }
      pinned = null;
    });
    card.addEventListener("dblclick", (e) => {
      if (e.target.closest(".zoombar")) return;
      const c = hitGeo(pos(e));
      if (!c) return;
      if (c.ips.length === 1) openIp(c.ips[0]);
      else nav("#/lieu?lat=" + c.lat.toFixed(4) + "&lon=" + c.lon.toFixed(4));
    });
    // zoom : molette sur la Terre, ou curseur
    const zb = h("div", { class: "zoombar", "aria-label": "Zoom" });
    const zr = h("input", { type: "range", min: 0, max: 1000, step: 1, "aria-label": "Niveau de zoom" });
    const zIn = h("button", { type: "button", title: "Zoomer", "aria-label": "Zoomer" }, "+");
    const zOut = h("button", { type: "button", title: "Dézoomer", "aria-label": "Dézoomer" }, "−");
    const zLab = h("button", { type: "button", class: "zl", title: "Revenir à 1×" }, "1×");
    zb.append(zIn, zr, zOut, zLab); card.appendChild(zb);
    const toSlider = (z) => Math.round(Math.log(z / ZMIN) / Math.log(ZMAX / ZMIN) * 1000);
    function setZoom(z) {
      zoom = Math.max(ZMIN, Math.min(ZMAX, z));
      zr.value = toSlider(zoom); zLab.textContent = (zoom < 1.95 ? zoom.toFixed(1) : Math.round(zoom * 10) / 10) + "×";
      try { localStorage.setItem("orbite-zoom", String(zoom)); } catch (err) {}
    }
    zr.addEventListener("input", () => setZoom(ZMIN * Math.pow(ZMAX / ZMIN, zr.value / 1000)));
    zIn.addEventListener("click", () => setZoom(zoom * 1.25));
    zOut.addEventListener("click", () => setZoom(zoom / 1.25));
    zLab.addEventListener("click", () => setZoom(1));
    card.addEventListener("wheel", (e) => {
      const m = pos(e), over = Math.hypot(m.x - G_cx, m.y - G_cy) < G_R * 1.1;
      if (!over && zoom <= 1.001) return;  // ailleurs dans la carte, la page defile normalement
      e.preventDefault();
      setZoom(zoom * Math.exp(-Math.max(-120, Math.min(120, e.deltaY)) * 0.0018));
    }, { passive: false });
    let z0 = 1; try { z0 = parseFloat(localStorage.getItem("orbite-zoom")) || 1; } catch (err) {}
    setZoom(z0);
    window.addEventListener("resize", resize);
    if (window.ResizeObserver) new ResizeObserver(resize).observe(cv.parentElement);
    theme(); requestAnimationFrame(frame);
    return { set, setGeo, resize, theme, setMax: (n) => { maxSats = n; }, setAnimate: (v) => { animate = v; } };
  })();

  // ---------- graphiques ----------
  function chart(el, times, series, unit) {
    el.textContent = "";
    const W = el.clientWidth, H = el.clientHeight;
    if (!W || !H) return;
    const m = { l: 40, r: 6, t: 8, b: 20 }, iw = W - m.l - m.r, ih = H - m.t - m.b;
    let max = 0;
    series.forEach((se) => se.v.forEach((v) => { if (v !== null && v > max) max = v; }));
    const step = niceStep(max || 1), top = Math.max(step, Math.ceil((max || 1) / step) * step);
    const t0 = times[0], t1 = times[times.length - 1] || t0 + 1;
    const X = (t) => m.l + ((t - t0) / Math.max(1, t1 - t0)) * iw, Y = (v) => m.t + ih - (v / top) * ih;
    const svg = s("svg", { viewBox: "0 0 " + W + " " + H, role: "img" });
    for (let v = 0; v <= top + 1e-9; v += step) {
      svg.append(s("line", { class: "gl", x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v) }));
      const tx = s("text", { x: m.l - 6, y: Y(v) + 4, "text-anchor": "end" }); tx.textContent = nf.format(v); svg.append(tx);
    }
    const long = t1 - t0 > 90000;
    for (let i = 0; i <= 4; i++) {
      const t = t0 + ((t1 - t0) * i) / 4, d = new Date(t * 1000);
      const tx = s("text", { x: X(t), y: H - 4, "text-anchor": i === 0 ? "start" : i === 4 ? "end" : "middle" });
      tx.textContent = long ? d.toLocaleDateString("fr-CA", { day: "numeric", month: "short" }) : d.toLocaleTimeString("fr-CA", { hour: "2-digit", minute: "2-digit" });
      svg.append(tx);
    }
    const defs = s("defs"); svg.append(defs);
    series.forEach((se, si) => {
      const id = "g" + el.id + si, lg = s("linearGradient", { id, x1: 0, y1: 0, x2: 0, y2: 1 });
      const a = s("stop", { offset: "0%", "stop-color": se.color, "stop-opacity": 0.35 }), b = s("stop", { offset: "100%", "stop-color": se.color, "stop-opacity": 0.02 });
      lg.append(a, b); defs.append(lg);
      let seg = [];
      const flush = () => {
        if (!seg.length) return;
        const line = seg.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join("");
        svg.append(s("path", { d: line + "L" + seg[seg.length - 1][0].toFixed(1) + " " + Y(0) + "L" + seg[0][0].toFixed(1) + " " + Y(0) + "Z", fill: "url(#" + id + ")" }));
        svg.append(s("path", { d: line, fill: "none", stroke: se.color, "stroke-width": 1.6, "stroke-linejoin": "round" }));
        if (seg.length === 1) svg.append(s("circle", { cx: seg[0][0], cy: seg[0][1], r: 2, fill: se.color }));
        seg = [];
      };
      se.v.forEach((v, i) => { if (v === null) flush(); else seg.push([X(times[i]), Y(v)]); });
      flush();
    });
    const cursor = s("line", { class: "gl", y1: m.t, y2: m.t + ih, x1: 0, x2: 0, visibility: "hidden", "stroke-dasharray": "3 3" });
    svg.append(cursor);
    el.append(svg);
    if (series.length > 1) el.append(h("div", { class: "keys" }, ...series.map((se) => h("span", null, h("i", { style: "background:" + se.color }), se.name))));
    const tipEl = h("div", { class: "ctip", hidden: "" }); el.append(tipEl);
    svg.addEventListener("mousemove", (e) => {
      const r = svg.getBoundingClientRect(), x = e.clientX - r.left;
      const t = t0 + ((x - m.l) / iw) * (t1 - t0);
      let i = 0, bd = Infinity;
      times.forEach((tt, k) => { const d = Math.abs(tt - t); if (d < bd) { bd = d; i = k; } });
      cursor.setAttribute("x1", X(times[i])); cursor.setAttribute("x2", X(times[i])); cursor.setAttribute("visibility", "visible");
      tipEl.textContent = "";
      tipEl.append(h("div", { class: "muted" }, when(times[i])));
      series.forEach((se) => tipEl.append(h("div", null, h("i", { style: "background:" + se.color }), se.name + " : " + (se.v[i] === null ? "—" : nf.format(se.v[i]) + (unit ? " " + unit : "")))));
      tipEl.hidden = false;
      const left = X(times[i]) + 12;
      tipEl.style.left = (left + tipEl.offsetWidth > W ? X(times[i]) - tipEl.offsetWidth - 12 : left) + "px";
    });
    svg.addEventListener("mouseleave", () => { cursor.setAttribute("visibility", "hidden"); tipEl.hidden = true; });
  }
  function niceStep(max) {
    const raw = max / 4, p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
  }
  let seriesData = null;
  function drawCharts() {
    if (!seriesData || tab !== "overview") return;
    const { bucket, since, rows } = seriesData;
    const map = new Map(rows.map((r) => [r.t, r]));
    const times = [];
    const end = Math.floor(Date.now() / 1000 / bucket) * bucket;
    for (let t = Math.ceil(since / bucket) * bucket; t <= end; t += bucket) times.push(t);
    const col = (k, zero) => times.map((t) => { const r = map.get(t); if (!r) return null; const v = r[k]; return v === null || v === undefined ? (zero ? 0 : null) : Math.round(v * 10) / 10; });
    chart($("#c-active"), times, [{ name: "Connexions", color: css("--c1"), v: col("active") }]);
    chart($("#c-ips"), times, [{ name: "Clients", color: css("--c4"), v: col("ips") }]);
    chart($("#c-new"), times, [{ name: "Entrantes", color: css("--c2"), v: col("new_in", 1) }, { name: "Sortantes", color: css("--c5"), v: col("new_out", 1) }]);
    chart($("#c-rtt"), times, [{ name: "Latence", color: css("--c3"), v: col("rtt") }], "ms");
    const mbit = (k) => times.map((t) => { const r = map.get(t); return !r || r[k] === null || r[k] === undefined ? null : Math.round((r[k] * 8) / 1e4) / 100; });
    chart($("#c-rate"), times, [{ name: "Entrant", color: css("--c2"), v: mbit("rx") }, { name: "Sortant", color: css("--c1"), v: mbit("tx") }], "Mbit/s");
    chart($("#c-http"), times, [{ name: "Requêtes", color: css("--c5"), v: col("http", 1) }]);
    chart($("#c-flags"), times, [{ name: "Alertes", color: css("--c3"), v: col("flags", 1) }, { name: "Bans", color: css("--c6"), v: col("bans", 1) }]);
  }
  async function loadSeries() {
    try { seriesData = await api("/api/series?range=" + $("#range").value); drawCharts(); } catch (e) {}
  }
  $("#range").addEventListener("change", loadSeries);
  window.addEventListener("resize", debounce(drawCharts, 150));

  // ---------- vue d'ensemble ----------
  function hud(st) {
    const el = $("#hud"); el.textContent = "";
    el.append(h("div", { class: "who" }, h("b", null, host || "Le serveur")),
      h("div", { class: "big" }, num(st.active)),
      h("div", { class: "what" }, "connexion" + (st.active > 1 ? "s" : "") + " en orbite"),
      h("div", { class: "asof" }, "(" + num(st.ips) + " client" + (st.ips > 1 ? "s" : "") + " · " + new Date().toLocaleTimeString("fr-CA", { hour: "2-digit", minute: "2-digit" }) + ")"));
    const rows = [["Débit entrant", rate(st.rx_bps)], ["Débit sortant", rate(st.tx_bps)], ["Durée moyenne", dur(st.avg_duration)], ["Latence moyenne", ms(st.avg_rtt)],
      ["Requêtes HTTP / min", num(st.http_rpm)], ["Alertes (24 h)", num(st.flags24h)], ["IP bannies", num(st.banned)]];
    const bar = $("#hudstats"); bar.textContent = "";
    rows.forEach((r) => bar.append(h("div", null, h("b", null, r[1]), h("span", null, r[0]))));
  }
  async function loadLive() {
    try {
      live = await api("/api/live");
      $("#pulse").className = "pulse " + (Date.now() / 1000 - live.ts < 30 ? "live" : "down");
      hud(live.stats); planet.set(live.nodes); planet.setGeo(live.geo || {}, live.home);
      const b = $("#badge-alerts"); b.hidden = !live.stats.unseen; b.textContent = live.stats.unseen;
      const box = $("#top-apps"); box.textContent = "";
      const max = Math.max(1, ...live.apps.map((a) => a.conns));
      if (!live.apps.length) box.append(h("div", { class: "empty" }, "Aucune connexion active pour l'instant."));
      live.apps.forEach((a) => box.append(h("div", { class: "item link", on: { click: () => nav("#/connexions?q=" + encodeURIComponent(a.app) + "&active=1") } },
        h("i", { class: "dot off" }), h("div", { class: "t" }, a.app, h("div", { class: "meter" }, h("i", { style: "width:" + (a.conns / max) * 100 + "%" }))), h("b", null, num(a.conns)))));
      if (tab === "connections" && $("#f-active").value === "1" && !$("#conn-more").dataset.extra) loadConnections(true);
    } catch (e) { if (e.message !== "401") $("#pulse").className = "pulse down"; }
  }
  async function loadRecent() {
    try {
      const d = await api("/api/flags?min=2&limit=7&unseen=1");
      const box = $("#recent-alerts"); box.textContent = "";
      $("#seen-recent").hidden = !d.rows.length;
      if (!d.rows.length) box.append(h("div", { class: "empty" }, "Aucune nouvelle alerte."));
      d.rows.forEach((f) => box.append(h("div", { class: "item link", on: { click: () => openIp(f.ip) } },
        h("i", { class: "dot " + (f.banned ? "banned" : f.severity === "high" ? "banned" : "suspect") }),
        h("div", { class: "t" }, f.kind, h("small", null, f.ip + " · " + f.detail)), h("small", null, when(f.last_ts)))));
    } catch (e) {}
  }
  async function loadStatus() {
    try {
      const st = await api("/api/status"), w = [];
      if (st.uptime > 20 && !st.conntrack) w.push("conntrack ne répond pas : seules les connexions TCP de l'hôte sont visibles (vérifie NET_ADMIN et le mode réseau host).");
      if (st.uptime > 20 && !st.process_names) w.push("Les noms de programmes ne sont pas lisibles (vérifie pid: host et apparmor:unconfined).");
      if (st.uptime > 40 && !st.docker) w.push("Le socket Docker n'est pas monté : les conteneurs apparaissent par adresse IP.");
      const missing = Object.keys(st.logs).filter((k) => !st.logs[k]);
      if (missing.length) w.push("Journaux introuvables : " + missing.join(", "));
      const el = $("#warn"); el.hidden = !w.length; el.textContent = w.join(" ");
    } catch (e) {}
  }

  // ---------- connexions ----------
  let connLast = null;
  async function loadConnections(reset) {
    const tb = $("#t-conn tbody"), more = $("#conn-more");
    const p = new URLSearchParams({ active: $("#f-active").value, dir: $("#f-dir").value, scope: $("#f-scope").value, q: $("#f-q").value.trim(), limit: 200 });
    if (!reset && connLast) p.set("before", connLast);
    try {
      const d = await api("/api/connections?" + p);
      if (reset) { tb.textContent = ""; delete more.dataset.extra; } else more.dataset.extra = "1";
      const now = Date.now() / 1000;
      d.rows.forEach((r) => {
        const st = r.active ? r.status : "off";
        tb.append(h("tr", null,
          h("td", null, h("i", { class: "dot " + (st === "ok" ? "" : st), title: r.active ? "en cours · " + STATUS_LABEL[r.status] : "terminée" })),
          ipCell(r.ip, r.host),
          h("td", null, r.direction === "in" ? "↓ entrante" : "↑ sortante"),
          h("td", null, r.app || "—"),
          h("td", { class: "num" }, r.lport), h("td", { class: "num" }, r.rport),
          h("td", null, r.proto.toUpperCase()),
          h("td", { class: "num" }, ms(r.rtt)), h("td", { class: "num" }, bytes(r.bytes)),
          h("td", null, when(r.first_seen)),
          h("td", { class: "num" }, dur((r.active ? now : r.last_seen) - r.first_seen))));
      });
      if (d.rows.length) connLast = d.rows[d.rows.length - 1].id;
      if (!tb.children.length) tb.append(h("tr", null, h("td", { colspan: 11, class: "empty" }, "Aucune connexion ne correspond.")));
      more.hidden = !d.more;
      $("#conn-count").textContent = tb.querySelectorAll("tr").length + " ligne(s) affichée(s)";
    } catch (e) {}
  }
  function filtersChanged() {
    const p = new URLSearchParams({ q: $("#f-q").value.trim(), active: $("#f-active").value, dir: $("#f-dir").value, scope: $("#f-scope").value });
    [...p.keys()].forEach((k) => { if (!p.get(k)) p.delete(k); });
    history.replaceState(null, "", "#/connexions?" + p);
    loadConnections(true);
  }
  ["#f-active", "#f-dir", "#f-scope"].forEach((id) => $(id).addEventListener("change", filtersChanged));
  $("#f-q").addEventListener("input", debounce(filtersChanged, 300));
  $("#conn-more").addEventListener("click", () => loadConnections(false));

  // ---------- alertes ----------
  async function loadFlags() {
    try {
      const d = await api("/api/flags?" + new URLSearchParams({ min: $("#a-min").value, q: $("#a-q").value.trim(), limit: 300 }));
      const tb = $("#t-flags tbody"); tb.textContent = "";
      d.rows.forEach((f) => tb.append(h("tr", null,
        h("td", null, when(f.last_ts), f.seen ? null : h("span", { class: "newtag" }, "nouvelle")), h("td", null, h("span", { class: "pill " + f.severity }, SEV_LABEL[f.severity])),
        ipCell(f.ip, f.banned ? "bannie par fail2ban" : f.host), h("td", null, f.kind),
        detailCell(f), h("td", { class: "num" }, f.count),
        h("td", null, h("button", { class: "btn small", title: "Effacer toutes les alertes de cette adresse", on: { click: async () => { await act("/api/unflag", { ip: f.ip }); loadFlags(); loadLive(); loadRecent(); } } }, "Effacer")))));
      if (!d.rows.length) tb.append(h("tr", null, h("td", { colspan: 7, class: "empty" }, "Aucune alerte.")));
    } catch (e) {}
  }
  async function markSeen() { await act("/api/flags/seen", {}); loadFlags(); loadRecent(); loadLive(); }
  $("#seen-recent").addEventListener("click", markSeen);
  $("#seen-all").addEventListener("click", markSeen);
  (function () {
    const btn = $("#clear-all"); let armed = null;
    btn.addEventListener("click", async () => {
      if (!armed) {
        btn.textContent = "Confirmer : tout effacer"; btn.classList.add("danger");
        armed = setTimeout(() => { armed = null; btn.textContent = "Tout effacer"; btn.classList.remove("danger"); }, 4000);
        return;
      }
      clearTimeout(armed); armed = null; btn.textContent = "Tout effacer"; btn.classList.remove("danger");
      await act("/api/flags/clear", {}); loadFlags(); loadRecent(); loadLive();
    });
  })();
  $("#a-min").addEventListener("change", loadFlags);
  $("#a-q").addEventListener("input", debounce(loadFlags, 300));

  // ---------- bannissements ----------
  async function loadBans() {
    try {
      const d = await api("/api/bans");
      $("#b-current").textContent = num(d.current.length); $("#b-24h").textContent = num(d.bans24h);
      $("#b-jails").textContent = d.jails.length ? d.jails.map((j) => (j.jail === "orbite" ? "Orbite" : j.jail) + " (" + j.n + ")").join(", ") : "—";
      const notes = [];
      if (!d.log_found) notes.push("Le journal de fail2ban est introuvable : vérifie que fail2ban est installé et qu'il écrit dans /var/log/fail2ban.log.");
      if (d.firewall.ok === false) notes.push("Le pare-feu d'Orbite n'est pas actif (" + (d.firewall.error || "nftables indisponible") + ") : les bans depuis l'app ne peuvent pas être appliqués.");
      else if (d.firewall.enforce_f2b) notes.push("Blocage complet actif : une adresse bannie par fail2ban ou par Orbite est coupée sur tous les ports, conteneurs compris.");
      const w = $("#bans-warn"); w.hidden = !notes.length; w.textContent = notes.join(" ");
      const a = $("#t-banned tbody"); a.textContent = "";
      d.current.forEach((b) => a.append(h("tr", null, ipCell(b.ip, b.host), h("td", null, b.manual ? "Orbite" : "fail2ban · " + b.jail), h("td", null, when(b.ts)),
        h("td", null, b.manual ? (b.expires ? when(b.expires) : "permanent") : "selon fail2ban"), h("td", null, b.blocked ? "oui" : "non"),
        h("td", null, h("button", { class: "btn small", on: { click: async () => { await doUnban(b.ip, $("#bans-err")); loadBans(); } } }, "Débannir")))));
      if (!d.current.length) a.append(h("tr", null, h("td", { colspan: 6, class: "empty" }, "Aucune adresse bannie.")));
      const e = $("#t-bans tbody"); e.textContent = "";
      d.events.forEach((b) => e.append(h("tr", null, h("td", null, when(b.ts)),
        h("td", null, h("span", { class: "pill " + (b.action === "unban" ? "info" : "high") }, BAN_LABEL[b.action] || b.action)), ipCell(b.ip), h("td", null, b.jail === "orbite" ? "Orbite" : b.jail))));
      if (!d.events.length) e.append(h("tr", null, h("td", { colspan: 4, class: "empty" }, "Aucune action enregistrée.")));
    } catch (e) {}
  }

  // ---------- bannir ----------
  const DURATIONS = [["24", "24 heures"], ["1", "1 heure"], ["168", "7 jours"], ["720", "30 jours"], ["0", "Permanent"]];
  const durSelect = () => h("select", { "aria-label": "Durée du blocage" }, ...DURATIONS.map((d) => h("option", { value: d[0] }, d[1])));
  async function doBan(ip, hours, reason, errEl) {
    if (errEl) errEl.hidden = true;
    try { await post("/api/ban", { ip, hours: Number(hours), reason }); return true; }
    catch (e) { if (errEl) { errEl.textContent = e.message; errEl.hidden = false; } return false; }
  }
  async function doUnban(ip, errEl) {
    if (errEl) errEl.hidden = true;
    try { await post("/api/unban", { ip }); return true; }
    catch (e) { if (errEl) { errEl.textContent = e.message; errEl.hidden = false; } else alert(e.message); return false; }
  }
  async function act(path, body, errEl) {
    if (errEl) errEl.hidden = true;
    try { await post(path, body); return true; }
    catch (e) { if (errEl) { errEl.textContent = e.message; errEl.hidden = false; } return false; }
  }

  // ---------- fiche d'une adresse ----------
  function detailCell(f) {
    const td = h("td", { class: "wrap" }, f.detail);
    if (f.verified === 0) td.append(h("small", { class: "unv", title: "Ces paquets n'ont pas fait de poignée de main TCP : leur adresse source peut être usurpée. Cette alerte ne déclenche jamais de bannissement automatique." }, "adresse source non vérifiée"));
    return td;
  }
  function kv(rows) {
    const dl = h("dl", { class: "kv" });
    rows.forEach((r) => { if (r && r[1] !== null && r[1] !== undefined && r[1] !== "") dl.append(h("dt", null, r[0]), h("dd", null, r[1])); });
    return dl;
  }
  const pillOf = (st) => (st === "banned" ? "high" : st === "suspect" ? "medium" : st === "bot" ? "info" : st === "self" ? "self" : "");
  function card(title, ...kids) { return h("div", { class: "card" }, h("h3", null, title), ...kids); }
  function tableCard(title, heads, rows, empty) {
    const tb = h("tbody");
    rows.forEach((r) => tb.append(r));
    if (!rows.length) tb.append(h("tr", null, h("td", { colspan: heads.length, class: "empty" }, empty)));
    return h("div", { class: "card table-card" }, h("h3", { class: "pad" }, title),
      h("div", { class: "table-wrap short" }, h("table", null, h("thead", null, h("tr", null, ...heads.map((x) => h("th", { class: x[1] || null }, x[0])))), tb)));
  }
  function identity(box, d, info) {
    box.textContent = "";
    const g = (info && info.geo) || {}, r = (info && info.rdap) || {};
    const kinds = [g.hosting ? "hébergeur ou centre de données" : null, g.proxy ? "proxy, VPN ou Tor" : null, g.mobile ? "réseau mobile" : null].filter(Boolean);
    const place = [g.city, g.regionName, g.country].filter(Boolean).join(", ");
    box.append(kv([
      ["Nom inverse (DNS)", d.host || "aucun"],
      ["Lieu approximatif", place], ["Fournisseur", g.isp], ["Organisation", g.org && g.org !== g.isp ? g.org : ""],
      ["Système autonome", g.as], ["Type de réseau", kinds.length ? kinds.join(", ") : (info && info.geo ? "résidentiel ou entreprise" : "")],
      ["Réseau", [r.network, r.range].filter(Boolean).join(" · ")], ["Titulaire", r.owner],
      ["Pays du registre", r.net_country], ["Enregistré le", r.registered], ["Contact d'abus", r.abuse],
      ["Version", "IPv" + d.version], ["Portée", d.scope === "wan" ? "Internet" : "réseau local"],
    ]));
    if (!info) box.append(h("div", { class: "muted small" }, "Recherche des renseignements…"));
    else if (info.local) box.append(h("div", { class: "muted small" }, "Adresse privée : aucune recherche externe."));
    else if (info.disabled) box.append(h("div", { class: "muted small" }, "Recherche externe désactivée (ORBITE_LOOKUP=0)."));
    else if (info.errors) box.append(h("div", { class: "muted small" }, "Recherche incomplète : " + info.errors.join(" ; ")));
    if (d.scope === "wan") {
      const e = encodeURIComponent(d.ip), a = (t, u) => h("a", { href: u, target: "_blank", rel: "noopener noreferrer" }, t);
      box.append(h("div", { class: "links" }, a("AbuseIPDB", "https://www.abuseipdb.com/check/" + e), a("Shodan", "https://www.shodan.io/host/" + e),
        a("VirusTotal", "https://www.virustotal.com/gui/ip-address/" + e), a("GreyNoise", "https://viz.greynoise.io/ip/" + e)));
    }
  }
  let currentPlace = { lat: "", lon: "" };
  async function loadPlace() {
    const box = $("#tab-place"), want = currentPlace;
    box.textContent = ""; box.append(h("div", { class: "empty" }, "Chargement…"));
    let d;
    try { d = await api("/api/place?lat=" + encodeURIComponent(want.lat) + "&lon=" + encodeURIComponent(want.lon)); } catch (e) { return; }
    if (currentPlace !== want || tab !== "place") return;
    box.textContent = "";
    const back = h("button", { class: "btn", on: { click: () => (history.length > 1 ? history.back() : nav("#/")) } }, "← Retour");
    if (d.error) { box.append(h("div", { class: "bar" }, h("div", { class: "ipbar" }, back)), h("div", { class: "notice" }, d.error)); return; }
    const name = [d.city, d.cc].filter(Boolean).join(", ") || "Lieu inconnu";
    const live = d.ips.reduce((a, r) => a + (r.active || 0), 0), sus = d.ips.filter((r) => r.status === "suspect" || r.status === "banned").length;
    box.append(h("div", { class: "bar" }, h("div", { class: "ipbar" }, back, h("h2", null, name),
      h("span", { class: "muted mono" }, d.lat.toFixed(1) + "°, " + d.lon.toFixed(1) + "°"))));
    box.append(h("div", { class: "grid stats" },
      h("div", { class: "card stat" }, h("span", { class: "k" }, "Adresses"), h("span", { class: "v" }, num(d.ips.length))),
      h("div", { class: "card stat" }, h("span", { class: "k" }, "Connexions en cours"), h("span", { class: "v" }, num(live))),
      h("div", { class: "card stat" }, h("span", { class: "k" }, "Suspectes ou bannies"), h("span", { class: "v" + (sus ? " hot" : "") }, num(sus)))));
    const rows = d.ips.map((r) => h("tr", { class: "link", on: { click: () => openIp(r.ip) } },
      h("td", null, h("a", { href: "#/ip/" + encodeURIComponent(r.ip), class: "mono" }, r.ip), r.host ? h("div", { class: "muted small" }, r.host) : null),
      h("td", null, h("span", { class: "pill " + pillOf(r.status) }, STATUS_LABEL[r.status] || r.status)),
      h("td", null, r.city || "—"),
      h("td", { class: "num" }, num(r.active || 0)),
      h("td", { class: "num" }, num(r.total || 0) + (r.total ? " (" + num(r.n_in || 0) + " ↓ / " + num(r.n_out || 0) + " ↑)" : "")),
      h("td", null, r.apps.join(", ") || "—"),
      h("td", { class: "num" }, r.flags ? num(r.flags) : "—"),
      h("td", null, r.last ? when(r.last) : "—")));
    box.append(tableCard("Adresses à cet endroit", [["Adresse"], ["État"], ["Ville"], ["En cours", "num"], ["Connexions", "num"], ["Applications"], ["Alertes", "num"], ["Dernière fois"]],
      rows, "Aucune adresse enregistrée à cet endroit."));
    box.append(h("p", { class: "muted small", style: "margin-top:10px" }, "Positions approximatives (ville ou fournisseur) : les adresses sont regroupées par case d'environ 50 km."));
  }
  async function loadIp() {
    const box = $("#tab-ip"), ip = currentIp;
    box.textContent = ""; box.append(h("div", { class: "empty" }, "Chargement…"));
    let d;
    try { d = await api("/api/ip?ip=" + encodeURIComponent(ip)); } catch (e) { return; }
    if (currentIp !== ip || tab !== "ip") return;
    box.textContent = "";
    if (d.error) { box.append(h("div", { class: "notice" }, d.error)); return; }
    const s = d.summary, now = Date.now() / 1000;

    const err = h("div", { class: "err", hidden: "" });
    const run = (path, body) => async () => { if (await act(path, body, err)) loadIp(); };
    const f2bJails = d.jails.filter((j) => j !== "orbite");
    // ligne 1 : bannissement
    const banRow = h("div", { class: "actrow" });
    if (d.manual || f2bJails.length) {
      const what = [d.manual ? "Orbite" + (d.manual.expires ? " jusqu'au " + when(d.manual.expires) : " (permanent)") : null,
        f2bJails.length ? "fail2ban (" + f2bJails.join(", ") + ")" : null].filter(Boolean).join(" et ");
      banRow.append(h("span", { class: "muted" }, "Bannie par " + what),
        h("button", { class: "btn", on: { click: async () => { if (await doUnban(d.ip, err)) loadIp(); } } }, "Débannir"));
      if (f2bJails.length && !d.f2b_unban) banRow.append(h("small", { class: "muted" }, "fail2ban n'est pas relié à Orbite : la commande à lancer s'affichera."));
    } else if (d.is_you) banRow.append(h("span", { class: "muted" }, "C'est ton adresse actuelle : elle ne peut pas être bannie."));
    else if (d.protected) banRow.append(h("span", { class: "muted" }, d.own ? "C'est ton adresse : elle ne peut pas être bannie." : d.whitelisted ? "En liste blanche : elle ne peut pas être bannie." : "Adresse locale : elle ne peut pas être bannie."));
    else {
      const sel = durSelect();
      banRow.append(sel, h("button", { class: "btn danger", on: { click: async () => { if (await doBan(d.ip, sel.value, "Depuis la fiche de l'adresse", err)) loadIp(); } } }, "Bannir"));
    }
    // ligne 2 : signalement et confiance
    const flagRow = h("div", { class: "actrow" });
    if (d.active_flags) flagRow.append(h("button", { class: "btn", title: "Les alertes restent dans l'historique, marquées comme effacées", on: { click: run("/api/unflag", { ip: d.ip }) } }, "Effacer les alertes (" + d.active_flags + ")"));
    const note = h("input", { placeholder: "Raison du signalement", maxlength: 200, class: "grow" });
    const sev = h("select", { "aria-label": "Gravité" }, h("option", { value: "medium" }, "Moyenne"), h("option", { value: "high" }, "Grave"));
    const flagForm = h("div", { class: "actrow", hidden: "" }, note, sev,
      h("button", { class: "btn", on: { click: async () => { if (await act("/api/flag", { ip: d.ip, sev: sev.value, note: note.value }, err)) loadIp(); } } }, "Signaler"),
      h("button", { class: "btn", on: { click: () => { flagForm.hidden = true; } } }, "Annuler"));
    if (!d.own) flagRow.append(h("button", { class: "btn", on: { click: () => { flagForm.hidden = false; note.focus(); } } }, "Signaler comme suspecte"));
    flagRow.append(d.whitelisted
      ? h("button", { class: "btn", on: { click: run("/api/trust", { ip: d.ip, list: "whitelist", add: false }) } }, "Retirer de la liste blanche")
      : h("button", { class: "btn", title: "Jamais signalée ni bannie. Ses alertes actuelles sont effacées.", on: { click: run("/api/trust", { ip: d.ip, list: "whitelist", add: true }) } }, "Ajouter à la liste blanche"));
    flagRow.append(d.own
      ? h("button", { class: "btn", on: { click: run("/api/trust", { ip: d.ip, list: "own_ips", add: false }) } }, "Ce n'est pas mon adresse")
      : h("button", { class: "btn", title: "Ton IP publique (boucle NAT) : affichée sur l'anneau du réseau local, jamais signalée", on: { click: run("/api/trust", { ip: d.ip, list: "own_ips", add: true }) } }, "C'est mon adresse"));
    box.append(h("div", { class: "bar" },
      h("div", { class: "ipbar" }, h("button", { class: "btn", on: { click: () => (history.length > 1 ? history.back() : nav("#/")) } }, "← Retour"),
        h("h2", { class: "mono" }, d.ip), h("span", { class: "pill " + pillOf(d.status) }, STATUS_LABEL[d.status]))));
    box.append(h("div", { class: "card ipactions" }, banRow, flagRow, flagForm, err));
    if (d.jails.length || d.blocked) {
      const f2b = d.jails.filter((j) => j !== "orbite");
      box.append(h("div", { class: "notice" }, (f2b.length ? "Bannie par fail2ban (" + f2b.join(", ") + "). " : "") +
        (d.blocked ? "Blocage complet actif : tous les ports, conteneurs compris." : "Le blocage complet n'est pas actif pour cette adresse.")));
    }

    const idBox = h("div");
    identity(idBox, d, null);
    const chartEl = h("div", { class: "chart", id: "c-ip" });
    box.append(h("div", { class: "grid two" },
      card("Identité", idBox),
      card("Activité sur ton serveur", kv([
        ["Première fois", s.first ? when(s.first) : "jamais vue"], ["Dernière fois", s.last ? when(s.last) : ""],
        ["Connexions enregistrées", num(s.total)], ["En cours", num(s.active)],
        ["Entrantes / sortantes", num(s.n_in || 0) + " / " + num(s.n_out || 0)],
        ["Données échangées", bytes(s.bytes)], ["Latence moyenne", s.rtt === null ? "" : ms(Math.round(s.rtt * 10) / 10)],
        ["Requêtes web (7 j)", d.http_stats.n ? num(d.http_stats.n) + " · " + num(d.http_stats.errors || 0) + " en erreur · " + num(d.http_stats.paths) + " chemins" : ""],
        ["Alertes", num(d.flags.length)],
      ]), h("div", { class: "links" }, h("a", { href: "#/connexions?q=" + encodeURIComponent(d.ip) + "&active=0" }, "Voir toutes ses connexions"))),
      card("Applications contactées", h("div", { class: "chips" }, ...(d.apps.length ? d.apps.map((a) => h("span", { class: "chip" }, a.app || "—", h("b", null, num(a.n)))) : [h("span", { class: "muted" }, "Aucune.")]))),
      card("Ports touchés", h("div", { class: "chips" }, ...(d.ports.length ? d.ports.map((p) => h("span", { class: "chip" }, (p.direction === "in" ? "↓ " : "↑ ") + p.port + "/" + p.proto, h("b", null, num(p.n)))) : [h("span", { class: "muted" }, "Aucun.")])))));
    box.append(h("div", { class: "card", style: "margin-top:16px" }, h("h3", null, "Connexions par heure"), h("p", { class: "sub" }, "48 dernières heures"), chartEl));
    const times = [], vals = [], map = new Map(d.hours.map((x) => [x.t, x.n]));
    for (let t = Math.floor((now - 48 * 3600) / 3600) * 3600; t <= now; t += 3600) { times.push(t); vals.push(map.get(t) || 0); }
    chart(chartEl, times, [{ name: "Connexions", color: css("--c1"), v: vals }]);

    box.append(h("div", { class: "grid two", style: "margin-top:16px" },
      tableCard("Alertes", [["Dernière fois"], ["Gravité"], ["Type"], ["Détail"], ["Fois", "num"]],
        d.flags.map((f) => h("tr", { class: f.cleared ? "cleared" : null, title: f.cleared ? "Effacée le " + when(f.cleared) : null }, h("td", null, when(f.last_ts)), h("td", null, h("span", { class: "pill " + f.severity }, SEV_LABEL[f.severity])),
          h("td", null, f.kind), detailCell(f), h("td", { class: "num" }, f.count))), "Aucune alerte pour cette adresse."),
      tableCard("Historique des bans", [["Heure"], ["Action"], ["Source"]],
        d.events.map((b) => h("tr", null, h("td", null, when(b.ts)), h("td", null, h("span", { class: "pill " + (b.action === "unban" ? "info" : "high") }, BAN_LABEL[b.action] || b.action)),
          h("td", null, b.jail === "orbite" ? "Orbite" : "fail2ban · " + b.jail))), "Jamais bannie.")));
    box.append(h("div", { style: "margin-top:16px" }, tableCard("Requêtes web récentes", [["Heure"], ["Méthode"], ["Chemin"], ["Code", "num"], ["Agent"]],
      d.http.map((r) => h("tr", null, h("td", null, when(r.ts)), h("td", null, r.method), h("td", { class: "wrap mono" }, r.path),
        h("td", { class: "num" }, r.status), h("td", { class: "wrap" }, r.ua || "(vide)"))), "Aucune requête web enregistrée pour cette adresse.")));
    box.append(h("div", { style: "margin-top:16px" }, tableCard("Dernières connexions", [["Début"], ["Sens"], ["Application"], ["Port local", "num"], ["Port distant", "num"], ["Proto"], ["Données", "num"], ["Durée", "num"]],
      d.connections.map((r) => h("tr", null, h("td", null, when(r.first_seen)), h("td", null, r.direction === "in" ? "↓ entrante" : "↑ sortante"), h("td", null, r.app || "—"),
        h("td", { class: "num" }, r.lport), h("td", { class: "num" }, r.rport), h("td", null, r.proto.toUpperCase()), h("td", { class: "num" }, bytes(r.bytes)),
        h("td", { class: "num" }, r.active ? "en cours" : dur(r.last_seen - r.first_seen)))), "Aucune connexion enregistrée.")));

    try { const info = await api("/api/ipinfo?ip=" + encodeURIComponent(ip)); if (currentIp === ip) identity(idBox, d, info); } catch (e) {}
  }

  (function () {
    const sel = durSelect(); sel.id = "ban-hours"; $("#ban-dur").replaceWith(sel);
    $("#ban-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      if (await doBan($("#ban-ip").value.trim(), sel.value, $("#ban-reason").value.trim(), $("#ban-err"))) { $("#ban-ip").value = ""; $("#ban-reason").value = ""; loadBans(); }
    });
  })();

  // ---------- preferences d'affichage (propres a ce navigateur) ----------
  const PREFS_DEFAULT = { refresh: 4, sats: 180, animate: true };
  let prefs = Object.assign({}, PREFS_DEFAULT);
  try { Object.assign(prefs, JSON.parse(localStorage.getItem("orbite-prefs") || "{}")); } catch (e) {}
  function savePrefs() { try { localStorage.setItem("orbite-prefs", JSON.stringify(prefs)); } catch (e) {} }
  function applyPrefs() { planet.setMax(prefs.sats); planet.setAnimate(prefs.animate); }
  function themeChoice() { let t = null; try { t = localStorage.getItem("orbite-theme"); } catch (e) {} return t === "dark" || t === "light" ? t : "auto"; }
  function setTheme(choice) {
    try { if (choice === "auto") localStorage.removeItem("orbite-theme"); else localStorage.setItem("orbite-theme", choice); } catch (e) {}
    const t = choice === "auto" ? (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark") : choice;
    document.documentElement.setAttribute("data-theme", t);
    planet.theme(); drawCharts();
  }
  function startTimers() {
    timers.forEach(clearInterval);
    timers = [
      setInterval(() => { if (!document.hidden) loadLive(); }, prefs.refresh * 1000),
      setInterval(() => { if (!document.hidden) { loadRecent(); if (tab === "alerts") loadFlags(); if (tab === "bans") loadBans(); if (panelOpen()) refreshSystem(); } }, 15000),
      setInterval(() => { if (!document.hidden) { loadSeries(); loadStatus(); } }, 60000),
    ];
  }

  // ---------- panneau des parametres ----------
  const KIND_HELP = {
    "Balayage de ports": "plusieurs ports différents touchés en peu de temps",
    "Recherche de failles web": "/.env, /.git, wp-login.php, etc.",
    "Force brute": "échecs de connexion SSH répétés",
    "Outil de balayage": "zgrab, masscan, nmap, sqlmap…",
    "Sonde sur port sensible": "tentative sur SMB, MySQL, RDP, Redis…",
    "Port sensible accessible": "un port sensible a répondu depuis Internet",
    "Sondes sans réponse": "beaucoup de tentatives restées sans réponse",
    "Rafale de connexions": "trop de nouvelles connexions par minute",
    "Erreurs HTTP en série": "beaucoup d'erreurs 4xx par minute",
    "Échec de connexion à Orbite": "mauvais mot de passe sur cette page",
  };
  const SETTING_LABELS = {
    autoban_points: "Points avant bannissement", autoban_window: "Fenêtre de calcul", autoban_hours: "Durée du bannissement",
    portscan_ports: "Balayage de ports", flood_per_min: "Rafale de connexions", probes: "Sondes sans réponse",
    http_errors_per_min: "Erreurs HTTP en série", auth_fails: "Force brute SSH", whitelist: "Liste blanche", own_ips: "Mes adresses publiques",
    ignore_apps: "Applications ignorées", ignore_ports: "Ports ignorés", retention_days: "Jours d'historique",
  };
  let S = null, draft = null;
  const panel = $("#settings");
  const panelOpen = () => document.body.classList.contains("panel-open");
  function togglePanel(force) {
    const open = force === undefined ? !panelOpen() : force;
    document.body.classList.toggle("panel-open", open);
    panel.setAttribute("aria-hidden", open ? "false" : "true");
    $("#open-settings").classList.toggle("on", open);
    try { localStorage.setItem("orbite-panel", open ? "1" : "0"); } catch (e) {}
    if (open) loadSettings();
    setTimeout(() => { planet.resize(); drawCharts(); }, 260);
  }
  $("#open-settings").addEventListener("click", () => togglePanel());
  $("#close-settings").addEventListener("click", () => togglePanel(false));
  $("#panel-shade").addEventListener("click", () => togglePanel(false));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && panelOpen()) togglePanel(false); });

  function sec(title, desc, ...kids) {
    return h("section", { class: "ps" }, h("h4", null, title), desc ? h("p", { class: "sub" }, desc) : null, ...kids);
  }
  function field(label, help, input) { return h("label", { class: "pf" }, h("span", { class: "pl" }, label, help ? h("small", null, help) : null), input); }
  function toggle(key, label, help) {
    const i = h("input", { type: "checkbox" }); i.checked = !!draft[key];
    i.addEventListener("change", () => { draft[key] = i.checked; dirty(); });
    return h("label", { class: "pt" }, i, h("span", { class: "sw" }), h("span", { class: "pl" }, label, help ? h("small", null, help) : null));
  }
  function number(key, step) {
    const i = h("input", { type: "number", step: step || 1, value: draft[key] });
    i.addEventListener("input", () => { draft[key] = i.value === "" ? "" : Number(i.value); dirty(); });
    i.dataset.key = key;
    return i;
  }
  function listInput(key, placeholder, rows) {
    const t = h("textarea", { rows: rows || 3, placeholder, spellcheck: "false" });
    t.value = (draft[key] || []).join("\n");
    t.addEventListener("input", () => { draft[key] = t.value.split(/[\n,]+/).map((v) => v.trim()).filter(Boolean); dirty(); });
    t.dataset.key = key;
    return t;
  }
  function seg(options, value, onPick) {
    const box = h("div", { class: "seg", role: "radiogroup" });
    options.forEach(([v, label]) => {
      const b = h("button", { type: "button", class: v === value ? "on" : "", "aria-pressed": v === value ? "true" : "false" }, label);
      b.addEventListener("click", () => { box.querySelectorAll("button").forEach((x) => { x.classList.remove("on"); x.setAttribute("aria-pressed", "false"); }); b.classList.add("on"); b.setAttribute("aria-pressed", "true"); onPick(v); });
      box.append(b);
    });
    return box;
  }
  function dirty() {
    const changed = JSON.stringify(draft) !== JSON.stringify(S.values);
    $("#ps-save").disabled = !changed; $("#ps-state").textContent = changed ? "Modifications non enregistrées" : "";
  }
  function stat(ok, label, detail) {
    return h("div", { class: "sysrow" }, h("i", { class: "dot " + (ok === true ? "" : ok === false ? "banned" : "off") }), h("span", null, label), h("small", null, detail || ""));
  }
  function bytesShort(b) { return b === null || b === undefined ? "—" : bytes(b); }
  function renderSystem(box) {
    const y = S.system; box.textContent = "";
    box.append(
      stat(y.conntrack, "Table des connexions (conntrack)", y.conntrack ? "OK" : "indisponible"),
      stat(y.process_names, "Noms des programmes", y.process_names ? "OK" : "indisponible"),
      stat(y.docker, "Noms des conteneurs (Docker)", y.docker ? "OK" : "socket absent"),
      stat(y.firewall, "Pare-feu d'Orbite (nftables)", y.firewall ? y.blocked + " adresse(s) bloquée(s)" : (y.firewall_error || "inactif")),
      ...Object.keys(y.logs).map((k) => stat(y.logs[k], "Journal " + k.split("/").slice(-2).join("/"), y.logs[k] ? "lu" : "introuvable")));
    box.append(kv([
      ["Bans automatiques", num(y.auto_bans) + " depuis le démarrage" + (y.auto_simulated ? " · " + num(y.auto_simulated) + " simulé(s)" : "")],
      ["Dernière erreur d'auto-ban", y.auto_error],
      ["Connexions suivies", num(y.tracked)], ["Collecte", "toutes les " + y.interval + " s"],
      ["Base de données", bytesShort(y.db_size) + " · " + num(y.counts.connections) + " connexions · " + num(y.counts.flags) + " alertes"],
      ["En marche depuis", dur(y.uptime)], ["Serveur", y.host], ["Ton adresse", y.your_ip],
    ]));
  }
  async function refreshSystem() {
    try { const d = await api("/api/settings"); if (S) { S.system = d.system; const b = $("#ps-system"); if (b) renderSystem(b); } } catch (e) {}
  }
  async function loadSettings() {
    const body = $("#ps-body");
    if (!S) { body.textContent = ""; body.append(h("div", { class: "empty" }, "Chargement…")); }
    try { S = await api("/api/settings"); } catch (e) { return; }
    draft = JSON.parse(JSON.stringify(S.values));
    renderSettings();
  }
  function renderSettings() {
    const body = $("#ps-body"); body.textContent = "";
    const v = draft;

    // bannissement automatique
    const modeHelp = h("p", { class: "sub" });
    const setModeHelp = (m) => { modeHelp.textContent = { off: "Aucun bannissement automatique.", test: "Les adresses qui seraient bannies sont seulement signalées (alerte « Bannissement simulé »).", on: "Les adresses qui dépassent les règles sont bloquées sur tous les ports." }[m]; };
    setModeHelp(v.autoban_mode);
    const kinds = h("div", { class: "checks" });
    S.kinds.forEach((k) => {
      const i = h("input", { type: "checkbox" }); i.checked = v.autoban_instant.includes(k);
      i.addEventListener("change", () => { draft.autoban_instant = S.kinds.filter((x) => x === k ? i.checked : draft.autoban_instant.includes(x)); dirty(); });
      kinds.append(h("label", { class: "ck" }, i, h("span", null, k, h("small", null, KIND_HELP[k] || ""))));
    });
    const hours = h("select");
    [[1, "1 heure"], [6, "6 heures"], [24, "24 heures"], [72, "3 jours"], [168, "7 jours"], [720, "30 jours"], [0, "Permanent"]].forEach(([val, l]) => hours.append(h("option", { value: val }, l)));
    if (![1, 6, 24, 72, 168, 720, 0].includes(Number(v.autoban_hours))) hours.append(h("option", { value: v.autoban_hours }, v.autoban_hours + " h"));
    hours.value = String(v.autoban_hours);
    hours.addEventListener("change", () => { draft.autoban_hours = Number(hours.value); dirty(); });
    body.append(sec("Bannissement automatique", null,
      seg([["off", "Désactivé"], ["test", "Mode test"], ["on", "Actif"]], v.autoban_mode, (m) => { draft.autoban_mode = m; setModeHelp(m); dirty(); }), modeHelp,
      h("div", { class: "pgroup" }, h("div", { class: "pl" }, "Bannir dès la première alerte de ce type"), kinds),
      field("Points avant bannissement", "Alerte grave = 3 points, moyenne = 1 point (max. 5 fois par alerte)", number("autoban_points")),
      field("Fenêtre de calcul (minutes)", "Seules les alertes de cette période comptent", number("autoban_window")),
      toggle("autoban_include_medium", "Compter les alertes moyennes", "Désactivé : seules les alertes graves donnent des points"),
      field("Durée du bannissement", null, hours),
      toggle("autoban_escalate", "Doubler la durée à chaque récidive", "Jusqu'à 1 an maximum"),
      h("p", { class: "sub note" }, "Jamais bannies automatiquement : les adresses locales, la liste blanche et les adresses connectées à Orbite.")));

    // detection
    body.append(sec("Seuils de détection", "Une alerte est créée quand une adresse dépasse ces seuils.",
      field("Balayage de ports", "Ports différents en 5 minutes", number("portscan_ports")),
      field("Rafale de connexions", "Nouvelles connexions par minute", number("flood_per_min")),
      field("Sondes sans réponse", "Tentatives sans réponse en 5 minutes", number("probes")),
      field("Erreurs HTTP en série", "Erreurs 4xx par minute", number("http_errors_per_min")),
      field("Force brute SSH", "Échecs en 10 minutes", number("auth_fails")),
      toggle("flag_crawlers", "Signaler les robots d'indexation", "Google, Bing, etc. (niveau info, sans points)"),
      toggle("flag_lan", "Analyser aussi le réseau local", "Par défaut, seules les adresses d'Internet sont analysées")));

    // liste blanche
    const wl = listInput("whitelist", "Une adresse ou une plage par ligne, ex. 203.0.113.25 ou 192.168.1.0/24", 4);
    const me = S.system.your_ip;
    body.append(sec("Liste blanche", "Jamais signalées ni bannies, par Orbite ou automatiquement.", wl,
      me && !v.whitelist.includes(me) ? h("button", { type: "button", class: "btn small", on: { click: (e) => { draft.whitelist = [...draft.whitelist, me]; wl.value = draft.whitelist.join("\n"); e.target.remove(); dirty(); } } }, "Ajouter mon adresse (" + me + ")") : null));

    // mes adresses
    body.append(sec("Mes adresses publiques", "Ton IP publique et celles de tes autres lieux. Le trafic qui revient par la boucle NAT (tes appareils qui ouvrent tes propres domaines) s'affiche sur l'anneau du réseau local, sans jamais être signalé ni banni.",
      listInput("own_ips", "ex. 198.51.100.7", 2)));

    // collecte
    body.append(sec("Collecte et historique", null,
      field("Applications ignorées", "Non enregistrées, ex. qbittorrent", listInput("ignore_apps", "qbittorrent", 2)),
      field("Ports ignorés", "Ports locaux non enregistrés", listInput("ignore_ports", "6881", 2)),
      field("Jours d'historique", "Connexions, alertes et graphiques plus vieux sont effacés", number("retention_days")),
      toggle("log_lan", "Enregistrer le réseau local", "Connexions entre le serveur et tes appareils"),
      toggle("rdns", "Résoudre les noms (DNS inverse)", "Affiche le nom d'hôte des adresses"),
      toggle("lookup", "Renseignements externes sur les IP", "Envoie l'adresse consultée à rdap.org et ip-api.com"),
      toggle("geo_points", "Points des adresses sur la Terre", "Envoie les adresses connectées à ip-api.com (par lots, gardées 30 jours). Nécessite l'option précédente"),
      toggle("enforce_f2b", "Blocage complet des IP fail2ban", "Coupe aussi leurs connexions aux conteneurs")));

    const foot = $("#ps-foot"); foot.textContent = "";
    foot.append(h("div", { class: "psbar" },
      h("button", { id: "ps-save", class: "btn primary", disabled: "", on: { click: saveSettings } }, "Enregistrer"),
      h("button", { class: "btn", on: { click: resetSettings } }, "Valeurs par défaut"),
      h("span", { id: "ps-state", class: "muted small0" })), h("div", { id: "ps-err", class: "err", hidden: "" }));
    foot.hidden = false;

    // affichage (local)
    const refresh = h("select"); [[2, "2 secondes"], [4, "4 secondes"], [10, "10 secondes"], [30, "30 secondes"]].forEach(([val, l]) => refresh.append(h("option", { value: val }, l)));
    refresh.value = String(prefs.refresh);
    refresh.addEventListener("change", () => { prefs.refresh = Number(refresh.value); savePrefs(); startTimers(); });
    const sats = h("select"); [[60, "60"], [120, "120"], [180, "180"], [300, "300"]].forEach(([val, l]) => sats.append(h("option", { value: val }, l)));
    sats.value = String(prefs.sats);
    sats.addEventListener("change", () => { prefs.sats = Number(sats.value); savePrefs(); applyPrefs(); loadLive(); });
    const anim = h("input", { type: "checkbox" }); anim.checked = prefs.animate;
    anim.addEventListener("change", () => { prefs.animate = anim.checked; savePrefs(); applyPrefs(); });
    body.append(sec("Affichage", "Enregistré dans ce navigateur seulement.",
      field("Thème", null, seg([["auto", "Système"], ["dark", "Sombre"], ["light", "Clair"]], themeChoice(), setTheme)),
      field("Actualisation", null, refresh),
      field("Satellites affichés au maximum", null, sats),
      h("label", { class: "pt" }, anim, h("span", { class: "sw" }), h("span", { class: "pl" }, "Animer la planète", h("small", null, "Désactive pour économiser le processeur")))));

    // compte
    const cur = h("input", { type: "password", autocomplete: "current-password" }), nw = h("input", { type: "password", autocomplete: "new-password" }), nw2 = h("input", { type: "password", autocomplete: "new-password" });
    const perr = h("div", { class: "err", hidden: "" }), pok = h("div", { class: "okmsg", hidden: "" });
    const pform = h("form", { class: "pform" }, field("Mot de passe actuel", null, cur), field("Nouveau mot de passe", "10 caractères ou plus", nw), field("Confirmer", null, nw2),
      h("button", { class: "btn", type: "submit" }, "Changer le mot de passe"), perr, pok);
    pform.addEventListener("submit", async (e) => {
      e.preventDefault(); perr.hidden = true; pok.hidden = true;
      if (nw.value !== nw2.value) { perr.textContent = "Les deux nouveaux mots de passe ne correspondent pas."; perr.hidden = false; return; }
      try { await post("/api/password", { current: cur.value, new: nw.value }); cur.value = nw.value = nw2.value = ""; pok.textContent = "Mot de passe changé. Les autres sessions ont été déconnectées."; pok.hidden = false; }
      catch (err) { perr.textContent = err.message; perr.hidden = false; }
    });
    body.append(sec("Compte", "Utilisateur : " + S.user + (S.password_from_app ? " · mot de passe défini dans l'app (celui du .env n'est plus utilisé)" : " · mot de passe du fichier .env"), pform));

    // systeme
    const sys = h("div", { id: "ps-system" });
    body.append(sec("Système", null, sys));
    renderSystem(sys);
  }
  async function saveSettings() {
    const err = $("#ps-err"); err.hidden = true;
    document.querySelectorAll("#ps-body .bad").forEach((x) => x.classList.remove("bad"));
    try {
      const r = await fetch("/api/settings", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ changes: draft }) });
      const d = await r.json();
      if (r.status === 401) return showLogin();
      if (!d.ok) {
        const names = Object.keys(d.errors || {});
        names.forEach((k) => { const el = document.querySelector('#ps-body [data-key="' + k + '"]'); if (el) el.classList.add("bad"); });
        err.textContent = names.map((k) => (SETTING_LABELS[k] || k) + " : " + d.errors[k]).join(" · ") || "Enregistrement refusé."; err.hidden = false; return;
      }
      S.values = d.values; draft = JSON.parse(JSON.stringify(d.values)); dirty();
      $("#ps-state").textContent = "Enregistré"; loadLive();
    } catch (e) { err.textContent = "Erreur réseau."; err.hidden = false; }
  }
  async function resetSettings() {
    try { const d = await post("/api/settings/reset"); S.values = d.values; draft = JSON.parse(JSON.stringify(d.values)); renderSettings(); $("#ps-state").textContent = "Valeurs par défaut rétablies"; } catch (e) {}
  }

  // ---------- demarrage ----------
  async function start() {
    const me = await api("/api/me");
    if (!me.auth) return showLogin();
    host = me.host; $("#host").textContent = host;
    $("#login").hidden = true; $("#app").hidden = false;
    planet.resize();
    loadLive(); loadSeries(); loadRecent(); loadStatus();
    applyPrefs(); startTimers();
    let open = false; try { open = localStorage.getItem("orbite-panel") === "1"; } catch (e) {}
    if (open && window.innerWidth > 1100) togglePanel(true);
    ready = true; route();
  }
  start().catch(() => showLogin());
})();
