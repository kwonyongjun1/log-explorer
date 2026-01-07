import os, json, random, string
from datetime import datetime, timedelta, timezone
import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

OUT_DIR = os.path.join("public", "data", "events")
os.makedirs(OUT_DIR, exist_ok=True)

SERVICES = ["api", "web", "worker", "billing", "search"]
LEVELS = ["info", "warn", "error"]
REGIONS = ["ap-northeast-2", "us-east-1", "eu-west-1"]
ENDPOINTS = ["/v1/login", "/v1/orders", "/v1/orders/{id}", "/v1/search", "/v1/payments"]

def rand_trace_id(n=16):
    return ''.join(random.choice(string.hexdigits.lower()) for _ in range(n))

def make_day(day_start: datetime, rows: int):
    ts = day_start + pd.to_timedelta(np.random.randint(0, 86400*1000, size=rows), unit="ms")

    service = np.random.choice(SERVICES, size=rows)
    level = np.random.choice(LEVELS, size=rows, p=[0.90, 0.08, 0.02])
    region = np.random.choice(REGIONS, size=rows)
    endpoint = np.random.choice(ENDPOINTS, size=rows)

    latency = np.random.gamma(shape=2.0, scale=120.0, size=rows).astype(int)
    status = np.where(level == "error", np.random.choice([500, 502, 503], size=rows),
             np.where(level == "warn", np.random.choice([200, 204, 429, 499], size=rows, p=[0.7,0.1,0.1,0.1]),
                      np.random.choice([200, 201, 204], size=rows, p=[0.8,0.1,0.1])))

    message_base = np.where(
        level == "error", "Upstream error",
        np.where(level == "warn", "Slow request", "Request completed")
    )

    trace_id = [rand_trace_id() for _ in range(rows)]
    message = [f"{message_base[i]} ({endpoint[i]}) trace={trace_id[i]}" for i in range(rows)]

    df = pd.DataFrame({
        "id": np.arange(rows, dtype=np.int64),
        "ts": pd.to_datetime(ts, utc=True),
        "service": service,
        "level": level,
        "message": message,
        "status": status.astype(int),
        "latency_ms": latency.astype(int),
        "endpoint": endpoint,
        "trace_id": trace_id,
        "region": region,
    })

    df = df.sort_values("ts", ascending=False).reset_index(drop=True)
    return df

def main():
    days = int(os.environ.get("DAYS", "30"))
    rows_per_day = int(os.environ.get("ROWS_PER_DAY", "50000"))

    start = datetime(2025, 1, 1, tzinfo=timezone.utc)
    manifest = {
        "version": 1,
        "schema": ["ts","service","level","message","status","latency_ms","endpoint","trace_id","region"],
        "shards": []
    }

    for i in range(days):
        day_start = start + timedelta(days=i)
        day_end = day_start + timedelta(days=1)

        df = make_day(day_start, rows_per_day)
        filename = f"events_{day_start.date().isoformat()}.parquet"
        path = os.path.join(OUT_DIR, filename)

        table = pa.Table.from_pandas(df, preserve_index=False)
        pq.write_table(table, path, compression="snappy")

        manifest["shards"].append({
            "file": filename,
            "from": day_start.isoformat().replace("+00:00", "Z"),
            "to": day_end.isoformat().replace("+00:00", "Z"),
            "rows": rows_per_day
        })

        print("wrote", filename)

    with open(os.path.join(OUT_DIR, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    print("wrote manifest.json")

if __name__ == "__main__":
    main()
