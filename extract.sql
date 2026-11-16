-- Daily Focus Product - import query (Power BI "import mode" style).
-- Returns ONE row with ONE column `j` (compact JSON). scripts/refresh.py writes it to data/daily.json.
--
-- It pulls EVERY paid line of the latest day in region_data.sales_daily (all brands, all categories),
-- aggregated per store x item x PO flag x line. Which brands / model types become columns is NOT decided
-- here: that lives in config/focus_products.json and is applied in the browser, so changing a column
-- never needs a new query.
--
-- Sources
--   region_data.sales_daily      today's POS lines (Order Status = PAID only)
--   region_data.master_region    site_code -> region (all regions)
--   sales_b2c.master_store_r5    site_code -> LOB, TSH, store name, status (Region 5)

WITH sd AS (
  SELECT *
  FROM `e-smart-433113.region_data.sales_daily`
  WHERE `Order Status` = 'PAID'
),
last_day AS (SELECT MAX(`Date`) AS d FROM sd),
sd_day AS (SELECT sd.* FROM sd, last_day WHERE sd.`Date` = last_day.d),

mr AS (
  SELECT site_code, ANY_VALUE(region) AS region, ANY_VALUE(site_desc) AS site_desc
  FROM `e-smart-433113.region_data.master_region`
  GROUP BY site_code
),
ms AS (
  SELECT site_code, ANY_VALUE(Store_Name) AS store_name, ANY_VALUE(LOB) AS lob, ANY_VALUE(TSH) AS tsh,
         ANY_VALUE(STATUS) AS status
  FROM `e-smart-433113.sales_b2c.master_store_r5`
  GROUP BY site_code
),

-- every store that sold today, plus every Active Region 5 store (so zero-sales stores can be shown)
site_list AS (
  SELECT DISTINCT `Site Code` AS site FROM sd_day
  UNION DISTINCT
  SELECT site_code FROM ms WHERE status = 'Active'
),
pos_attr AS (
  SELECT `Site Code` AS site, ANY_VALUE(`Site Description`) AS pos_desc, ANY_VALUE(region) AS pos_region,
         ANY_VALUE(lob) AS pos_lob, ANY_VALUE(tsh) AS pos_tsh
  FROM sd_day GROUP BY 1
),
stores AS (
  SELECT
    s.site,
    CASE
      WHEN UPPER(COALESCE(mr.region, p.pos_region, IF(ms.site_code IS NOT NULL, 'REGION 5', NULL))) = 'SERVICE CENTER' THEN 'Service Center'
      ELSE COALESCE(mr.region, p.pos_region, IF(ms.site_code IS NOT NULL, 'REGION 5', NULL), 'Unmapped')
    END AS region,
    COALESCE(ms.store_name, p.pos_desc, mr.site_desc, s.site) AS site_desc,
    COALESCE(ms.lob, p.pos_lob, '') AS lob,
    COALESCE(ms.tsh, p.pos_tsh, '') AS tsh,
    COALESCE(ms.status, '') AS status
  FROM site_list s
  LEFT JOIN mr ON mr.site_code = s.site
  LEFT JOIN ms ON ms.site_code = s.site
  LEFT JOIN pos_attr p ON p.site = s.site
),

item_key AS (
  SELECT *, IFNULL(CAST(CAST(`Item Code` AS INT64) AS STRING), 'NA') AS item FROM sd_day
  WHERE `Site Code` IS NOT NULL
),
items AS (
  SELECT item,
         ANY_VALUE(IFNULL(brandname, '')) AS brand,
         ANY_VALUE(IFNULL(product_category, '')) AS pc,
         ANY_VALUE(IFNULL(detail_cat, '')) AS dc,
         ANY_VALUE(IFNULL(model_type, '')) AS mt,
         ANY_VALUE(IFNULL(model_type_detail, '')) AS mtd,
         ANY_VALUE(IFNULL(rofo_category, '')) AS rofo,
         ANY_VALUE(IFNULL(`Item Description`, '')) AS descr
  FROM item_key GROUP BY item
),
facts AS (
  SELECT `Site Code` AS site, item, IFNULL(Ket_PO, '') AS po, IFNULL(line, '') AS line,
         SUM(Quantity) AS q
  FROM item_key GROUP BY ALL
  HAVING q <> 0
)

SELECT TO_JSON_STRING(STRUCT(
  CAST(CURRENT_DATETIME('Asia/Jakarta') AS STRING) AS refreshed_at,
  (SELECT d FROM last_day) AS data_date,                                        -- yyyy/mm/dd
  (SELECT MAX(`Time`) FROM sd_day) AS last_time,                                -- latest PAID transaction, all regions
  (SELECT MAX(`Time`) FROM sd_day WHERE region = 'REGION 5') AS last_time_r5,
  -- site|region|site_desc|lob|tsh|status
  ARRAY(SELECT CONCAT(site, '|', region, '|', REPLACE(site_desc, '|', '/'), '|', lob, '|', tsh, '|', status)
        FROM stores ORDER BY site) AS stores,
  -- item|brand|product_category|detail_cat|model_type|model_type_detail|rofo_category|item_description
  ARRAY(SELECT CONCAT(item, '|', brand, '|', pc, '|', dc, '|', mt, '|', mtd, '|', rofo, '|', REPLACE(descr, '|', '/'))
        FROM items ORDER BY item) AS items,
  -- site|item|ket_po|line|qty
  ARRAY(SELECT CONCAT(site, '|', item, '|', po, '|', line, '|', CAST(CAST(q AS INT64) AS STRING))
        FROM facts ORDER BY site, item) AS sales
)) AS j
