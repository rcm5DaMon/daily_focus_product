// Shared engine for index.html (dashboard) and admin.html (column editor).
// data/daily.json  = what BigQuery returned (every PAID line of the day, per store x item).
// config/focus_products.json = which tabs / columns to show. Applied here, in the browser.
"use strict";

const GITHUB_REPO = "rcm5DaMon/daily_focus_product";   // used for the Refresh / Edit links
const DRAFT_KEY = "dfp_config_draft";                    // admin.html preview draft (this browser only)

// Item fields a rule can test. Keys used in config -> index in an item record.
const ITEM_FIELDS = {
  brand: 1, product_category: 2, detail_cat: 3, model_type: 4,
  model_type_detail: 5, rofo_category: 6
};
const FIELD_LABELS = {
  brand: "Brand", product_category: "Product category", detail_cat: "Detail category",
  model_type: "Model type", model_type_detail: "Model type detail", rofo_category: "ROFO category",
  ket_po: "Ket PO", line: "Line (Include / Take Out)",
  item_contains: "Item description contains"
};
const RULE_KEYS = Object.keys(FIELD_LABELS);
const REGION_ORDER = ["Corporate", "REGION 1", "REGION 2", "REGION 3", "REGION 4", "REGION 5", "REGION 6", "Service Center"];

const U = s => String(s == null ? "" : s).trim().toUpperCase();

async function fetchJSON(path) {
  const r = await fetch(path + "?v=" + Date.now(), { cache: "no-store" });
  if (!r.ok) throw new Error(path + " -> HTTP " + r.status);
  return r.json();
}

function loadConfig() {
  return fetchJSON("config/focus_products.json");
}
// Draft = { base: <published config it was started from, as JSON text>, cfg: <edited config> }.
// Older drafts (saved before this format) are just the config object, with no base.
function draftRecord() {
  try { const s = localStorage.getItem(DRAFT_KEY); if (!s) return null; const d = JSON.parse(s); return d && d.cfg ? d : { base: null, cfg: d }; }
  catch (e) { return null; }
}
function draftConfig() { const d = draftRecord(); return d ? d.cfg : null; }

// Parse the compact extract into arrays.
function parseData(raw) {
  const stores = new Map();           // site -> {site, region, desc, lob, tsh, status}
  raw.stores = (raw.stores || []).filter(Boolean);
  raw.items = (raw.items || []).filter(Boolean);
  raw.sales = (raw.sales || []).filter(Boolean);
  for (const s of raw.stores) {
    const [site, region, desc, lob, tsh, status, bu] = s.split("|");
    stores.set(site, { site, region: region || "Unmapped", desc: desc || site, lob: lob || "", tsh: tsh || "", status: status || "", bu: bu || "" });
  }
  const items = new Map();            // item -> [item, brand, pc, dc, mt, mtd, rofo, DESC_UPPER, desc]
  for (const s of raw.items) {
    const p = s.split("|");
    const rec = [p[0], U(p[1]), U(p[2]), U(p[3]), U(p[4]), U(p[5]), U(p[6]), U(p.slice(7).join("|")), p.slice(7).join("|"), p[2], p[4], p[5]];
    items.set(p[0], rec);
  }
  const facts = [];                   // {site, item(rec), po, line, q}
  for (const s of raw.sales) {
    const [site, item, po, line, q] = s.split("|");
    const rec = items.get(item);
    if (!rec) continue;
    if (!stores.has(site)) stores.set(site, { site, region: "Unmapped", desc: site, lob: "", tsh: "", status: "", bu: "" });
    facts.push({ site, it: rec, po: U(po), line: U(line), q: +q });
  }
  return { raw, stores, items, facts };
}

// rule = { key: [values] }  (AND across keys, OR inside a list). Empty / missing rule matches everything.
function compileRule(rule) {
  const tests = [];
  for (const [k, vals] of Object.entries(rule || {})) {
    if (!Array.isArray(vals) || !vals.length) continue;
    const set = new Set(vals.map(U));
    if (k in ITEM_FIELDS) { const i = ITEM_FIELDS[k]; tests.push(f => set.has(f.it[i])); }
    else if (k === "ket_po") tests.push(f => set.has(f.po));
    else if (k === "line") tests.push(f => set.has(f.line));
    else if (k === "item_contains") { const arr = [...set]; tests.push(f => arr.some(v => f.it[7].includes(v))); }
  }
  return tests;
}
const passAll = (tests, f) => { for (const t of tests) if (!t(f)) return false; return true; };

// Effective test for one column: default_filter, then tab.filter, then column.match (later keys override earlier ones).
function compileColumn(config, tab, col) {
  const merged = Object.assign({}, config.default_filter || {}, tab.filter || {}, col.match || {});
  const inc = compileRule(merged);
  const exc = col.exclude && Object.keys(col.exclude).length ? compileRule(col.exclude) : null;
  return f => passAll(inc, f) && !(exc && exc.length && passAll(exc, f));
}

// Drill-down fields: what a column breaks into when expanded (tab.drill). Index into an item record.
const DRILL_FIELDS = {
  model_type_detail: 11, model_type: 10, brand: 1, detail_cat: 3, rofo_category: 6, item: 8
};
const DRILL_LABELS = {
  model_type_detail: "Model type detail", model_type: "Model type", brand: "Brand",
  detail_cat: "Detail category", rofo_category: "ROFO category", item: "Item description"
};

// Brands sold in a tab (inside default filter + tab filter), qty desc. Used by the Brand filter.
function tabBrands(data, config, tab) {
  const base = compileRule(Object.assign({}, config.default_filter || {}, tab.filter || {}));
  const m = new Map();
  for (const f of data.facts) if (passAll(base, f)) m.set(f.it[1], (m.get(f.it[1]) || 0) + f.q);
  return [...m.entries()].filter(e => e[1]).sort((a, b) => b[1] - a[1]).map(e => e[0]);
}

// computeTab(data, config, tab)                        -> Map(site -> Float64Array(ncols))
// computeTab(data, config, tab, {sub: true, brand})    -> {vals, sub}; sub = Map(site -> [Map(drillValue -> qty) per column])
function computeTab(data, config, tab, opts) {
  opts = opts || {};
  const tests = tab.columns.map(c => compileColumn(config, tab, c));
  const n = tests.length, out = new Map(), sub = opts.sub ? new Map() : null;
  const di = DRILL_FIELDS[tab.drill || "model_type_detail"] ?? 11;
  const brand = opts.brand ? U(opts.brand) : "";
  for (const f of data.facts) {
    if (brand && f.it[1] !== brand) continue;
    let row = null, srow = null;
    for (let i = 0; i < n; i++) {
      if (tests[i](f)) {
        if (!row) { row = out.get(f.site); if (!row) { row = new Float64Array(n); out.set(f.site, row); } }
        row[i] += f.q;
        if (sub) {
          if (!srow) { srow = sub.get(f.site); if (!srow) { srow = Array.from({ length: n }, () => new Map()); sub.set(f.site, srow); } }
          const k = f.it[di] || "(blank)";
          srow[i].set(k, (srow[i].get(k) || 0) + f.q);
        }
      }
    }
  }
  return sub ? { vals: out, sub } : out;
}

// Does a store pass config.zero_sales_store_filter (used for "show stores with no sales")?
function zeroSalesStore(config, s) {
  const r = config.zero_sales_store_filter || { status: ["Active"] };
  const has = (k, v) => !r[k] || !r[k].length || r[k].map(U).includes(U(v));
  return has("status", s.status) && has("bu_category", s.bu) && has("lob", s.lob) && has("tsh", s.tsh);
}

function regionRank(r) {
  const i = REGION_ORDER.indexOf(r);
  return i >= 0 ? i : (r === "Unmapped" ? 99 : 50);
}

function fmt(v) { return v ? Math.round(v).toLocaleString("en-US") : ""; }
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function fmtDate(d) { // "2026/11/16" -> "16 Nov 2026"
  if (!d) return "-";
  const [y, m, dd] = d.split(/[\/-]/);
  const mon = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][(+m) - 1] || m;
  return `${+dd} ${mon} ${y}`;
}

// ===== Lock for "Refresh data" and "Edit columns" =====
// Only a PBKDF2 hash of "username:password" is stored here (the repo is public), never the password itself.
// Unlocking lasts until the browser tab is closed (sessionStorage).
const LOCK = { salt: "d74b5f791a7a9855e54fc6fb4e286812", iter: 150000, hash: "86a1ac240b5e82a5a5f87479e554e08c2c75d39be3204b67866d347b77161905" };
const LOCK_KEY = "dfp_unlocked";
function isUnlocked() { try { return sessionStorage.getItem(LOCK_KEY) === LOCK.hash; } catch (e) { return false; } }
function relock() { try { sessionStorage.removeItem(LOCK_KEY); } catch (e) {} }
async function checkLogin(user, pass) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(user.trim() + ":" + pass), "PBKDF2", false, ["deriveBits"]);
  const salt = new Uint8Array(LOCK.salt.match(/../g).map(h => parseInt(h, 16)));
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: LOCK.iter }, key, 256);
  const hex = [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, "0")).join("");
  if (hex !== LOCK.hash) return false;
  try { sessionStorage.setItem(LOCK_KEY, LOCK.hash); } catch (e) {}
  return true;
}
// Shows a login box; resolves true when unlocked, false if cancelled. cancellable=false for pages that need the login.
function requireLogin(reason, cancellable = true) {
  if (isUnlocked()) return Promise.resolve(true);
  return new Promise(resolve => {
    const ov = document.createElement("div");
    ov.setAttribute("data-noshot", "");
    ov.style.cssText = "position:fixed;inset:0;z-index:100;display:flex;align-items:center;justify-content:center;background:rgba(21,43,60,.35);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);padding:16px";
    ov.innerHTML = `
      <form style="background:rgba(255,255,255,.96);border:1px solid #fff;border-radius:20px;box-shadow:0 20px 50px rgba(21,43,60,.3);padding:22px 22px 18px;width:340px;max-width:100%;font-family:inherit;color:#152b3c">
        <div style="font-size:18px;font-weight:800;color:#24506f;margin-bottom:4px">🔒 Login required</div>
        <div style="font-size:13px;color:#5d7488;margin-bottom:14px">${reason}</div>
        <label style="display:block;font-size:11px;font-weight:700;color:#5d7488;text-transform:uppercase;letter-spacing:.4px;margin-bottom:4px">Username</label>
        <input name="u" autocomplete="username" required style="width:100%;font-size:16px;padding:9px 11px;border:1px solid #b9d6ea;border-radius:10px;margin-bottom:10px;box-sizing:border-box">
        <label style="display:block;font-size:11px;font-weight:700;color:#5d7488;text-transform:uppercase;letter-spacing:.4px;margin-bottom:4px">Password</label>
        <input name="p" type="password" autocomplete="current-password" required style="width:100%;font-size:16px;padding:9px 11px;border:1px solid #b9d6ea;border-radius:10px;box-sizing:border-box">
        <div class="err" style="color:#b42318;font-size:12.5px;min-height:18px;margin:8px 0 6px"></div>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          ${cancellable ? '<button type="button" class="cx" style="font:600 14px inherit;font-family:inherit;padding:8px 14px;border-radius:10px;border:1px solid #d3e6f2;background:#fff;color:#24506f;cursor:pointer">Cancel</button>' : '<a href="index.html" style="font-size:14px;font-weight:600;padding:8px 14px;color:#24506f;text-decoration:none">← Dashboard</a>'}
          <button type="submit" style="font-size:14px;font-weight:600;font-family:inherit;padding:8px 16px;border-radius:10px;border:0;background:linear-gradient(135deg,#7fb4da,#3f78a6);color:#fff;cursor:pointer">Unlock</button>
        </div>
      </form>`;
    document.body.appendChild(ov);
    const f = ov.querySelector("form"), err = ov.querySelector(".err");
    f.u.focus();
    const done = ok => { ov.remove(); resolve(ok); };
    if (cancellable) { ov.querySelector(".cx").onclick = () => done(false); ov.onclick = e => { if (e.target === ov) done(false); }; }
    f.onsubmit = async e => {
      e.preventDefault(); err.textContent = "Checking…";
      const ok = await checkLogin(f.u.value, f.p.value);
      if (ok) done(true); else { err.textContent = "Wrong username or password."; f.p.value = ""; f.p.focus(); }
    };
  });
}
