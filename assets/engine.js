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
function draftConfig() {
  try { const s = localStorage.getItem(DRAFT_KEY); return s ? JSON.parse(s) : null; } catch (e) { return null; }
}

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
