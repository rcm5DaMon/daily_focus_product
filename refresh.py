"""Import-mode refresh: run sql/extract.sql once and write data/daily.json.

Runs in GitHub Actions (see .github/workflows/refresh.yml). Credentials come from
the GCP_SA_KEY secret via google-github-actions/auth, so nothing secret is in the repo.

The query pulls every PAID line of the latest day in region_data.sales_daily. Which
brands / model types become columns is decided by config/focus_products.json in the
browser, so editing the config never needs a new query.

Local run (optional):  pip install google-cloud-bigquery
                       gcloud auth application-default login
                       python scripts/refresh.py
"""
import json
import os
import pathlib
import sys

from google.cloud import bigquery

ROOT = pathlib.Path(__file__).resolve().parents[1]
PROJECT = os.environ.get("BQ_PROJECT", "e-smart-433113")
MAX_GB = float(os.environ.get("MAX_GB", "1"))  # safety cap per query

sql = (ROOT / "sql" / "extract.sql").read_text(encoding="utf-8")
client = bigquery.Client(project=PROJECT, location="asia-southeast2")

# 1) dry run = free cost check
dry = client.query(sql, job_config=bigquery.QueryJobConfig(dry_run=True, use_query_cache=False))
gb = dry.total_bytes_processed / 1e9
print(f"dry run: will scan {gb:.3f} GB")
if gb > MAX_GB:
    sys.exit(f"aborting: scan {gb:.2f} GB is above MAX_GB={MAX_GB}")

# 2) real run, capped so a bad edit can never bill more than MAX_GB
job = client.query(sql, job_config=bigquery.QueryJobConfig(
    maximum_bytes_billed=int(MAX_GB * 1e9), labels={"app": "focus-product-daily"}))
data = json.loads(next(iter(job.result()))["j"])
if not data.get("sales"):
    sys.exit("query returned no sales rows - sales_daily may be empty right now; keeping the old data file")

print(f"billed {job.total_bytes_billed / 1e9:.3f} GB · day {data['data_date']} · last time {data['last_time']} · "
      f"stores {len(data['stores'])} · items {len(data['items'])} · sales rows {len(data['sales'])}")

out = ROOT / "data" / "daily.json"
out.parent.mkdir(exist_ok=True)
out.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
print(f"wrote {out.relative_to(ROOT)} ({out.stat().st_size / 1024:.1f} KB)")
