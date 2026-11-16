# Report Daily Focus Product (web)

Web version of the Power BI "Report Daily Focus Product": 7 tabs (APPLE, SAMSUNG, XIAOMI, OPPO, VIVO,
OPERATOR & RC, ACC), each with the same layout:

- **Last Update / Last Time**: date of the data and the latest PAID transaction time in `sales_daily`
- **Sales all region**: qty per region (Corporate, Region 1-6, Service Center)
- **Region 5**: qty per LOB > TSH > store, with subtotals, filters for LOB, TSH and site desc, store search,
  sort by any column and CSV download

Same setup as `sbd_vivo`: **import mode**. One BigQuery query pulls the day's sales into `data/daily.json`;
every tab, filter and sort then runs in the browser at zero BigQuery cost.

| File | What it is |
|---|---|
| `index.html` | The dashboard |
| `admin.html` | **Back end**: edit tabs and columns (model type / model type detail) with today's qty as a live check |
| `config/focus_products.json` | The tab and column definitions the dashboard uses |
| `sql/extract.sql` | The one import query (`region_data.sales_daily` + `region_data.master_region` + `sales_b2c.master_store_r5`) |
| `scripts/refresh.py` | Dry-runs, runs the query (capped at 1 GB), writes `data/daily.json` |
| `assets/engine.js` | Applies the config to the data (shared by both pages) |
| `.github/workflows/refresh.yml` | The "Refresh data" button + GitHub Pages deploy |

## Daily use
Click **Refresh data** on the page (or Actions -> Refresh data -> Run workflow), wait about 1-2 minutes, reload (Ctrl+F5).

## Changing brands, model types or columns (the back end)
Open `admin.html` (the **Edit columns** button on the dashboard).

1. Pick a tab. The **tab filter** decides what the tab looks at (e.g. Brand = OPPO).
2. Each **column** counts items that match all of its conditions. A condition is a field + one or more values
   (comma separated, OR between values). Fields: Brand, Product category, Detail category, **Model type**,
   **Model type detail**, ROFO category, Ket PO, Line, Item description contains.
3. **Exclude rule** removes matching items from a column (e.g. "Other A6X" = Model type A6X, excluding item description containing 8/128).
4. The right-hand list shows every value sold today inside the tab filter. **+ col** makes it a new column,
   **+ sel** adds it to the selected column. The two numbers next to each column (All regions, R5) update as you edit.
5. **Preview dashboard** shows your draft without publishing. **Publish…** -> Copy JSON -> paste into
   `config/focus_products.json` on GitHub -> Commit. The site redeploys in about a minute; no query needed.

You can also edit `config/focus_products.json` directly. Example column:

```json
{ "label": "PO V80", "match": { "model_type": ["V80"], "ket_po": ["PO"] } }
```

## Definitions
- **Qty** = `SUM(Quantity)` of `Order Status = PAID` lines on the latest `Date` in `sales_daily`.
- **Default filter** (all columns): `Ket_PO = Non PO` and `line = Include`. A column can override it
  (e.g. the VIVO "PO V80" column uses `Ket PO = PO`).
- **Region** comes from `master_region` by site code ("Service center" is merged into "Service Center";
  sites not found show as "Unmapped").
- **LOB / TSH / store name** for Region 5 come from `master_store_r5`.
- "All Device" = product category Device (Macbook is product category Laptop, so it has its own column).
  "All Operator" = product category Operator (Repair Contract is its own column).

**Cost per refresh:** a few MB scanned (sales_daily holds one day), effectively free.

## Visibility
GitHub Pages sites are **public** unless the account has GitHub Enterprise Cloud with private Pages.
