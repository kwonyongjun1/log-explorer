import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { Virtuoso } from "react-virtuoso";
import { DuckClient } from "./lib/duckClient";
import { loadManifest, pickShards } from "./lib/manifest";
import { readFilters, writeFilters } from "./lib/urlState";
import type { Filters as UrlFilters } from "./lib/urlState";

type Row = {
  id: number;
  ts: string;
  service: string;
  level: string;
  status: number;
  latency_ms: number;
  endpoint: string;
  trace_id: string;
  region: string;
  message: string;
};

const isoDayStart = (d: Date) => {
  const x = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0)
  );
  return x.toISOString();
};

const App = () => {
  const [manifestReady, setManifestReady] = useState(false);
  const [manifest, setManifest] = useState<Awaited<
    ReturnType<typeof loadManifest>
  > | null>(null);

  const clientRef = useRef<DuckClient | null>(null);

  // default date range: first day -> +2 days (가볍게 시작)
  const defaults: UrlFilters = useMemo(() => {
    const now = new Date();
    const from = isoDayStart(new Date(now.getTime() - 2 * 24 * 3600 * 1000));
    const to = isoDayStart(new Date(now.getTime() + 1 * 24 * 3600 * 1000));
    return {
      from,
      to,
      q: "",
      service: "",
      level: "",
      endpoint: "",
      statusMin: "",
      statusMax: "",
      latencyMin: "",
      latencyMax: "",
    };
  }, []);

  const [filters, setFilters] = useState<UrlFilters>(() =>
    readFilters(defaults)
  );
  const [isPending, startTransition] = useTransition();

  const [summary, setSummary] = useState<any>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [cursor, setCursor] = useState<{ ts: string; id: number } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const c = new DuckClient();
        clientRef.current = c;
        await c.init();

        const m = await loadManifest();
        if (cancelled) return;
        setManifest(m);
        setManifestReady(true);
      } catch (e: any) {
        setError(e?.message ?? String(e));
      }
    })();

    return () => {
      cancelled = true;
      clientRef.current?.dispose();
      clientRef.current = null;
    };
  }, []);

  const shardFiles = useMemo(() => {
    if (!manifest) return [];
    const from = filters.from;
    const to = filters.to;
    if (!from || !to) return [];
    return pickShards(manifest, from, to);
  }, [manifest, filters.from, filters.to]);

  useEffect(() => {
    if (!manifestReady || !clientRef.current) return;
    if (!filters.from || !filters.to) return;
    if (shardFiles.length === 0) {
      setSummary({ total: 0, errors: 0, avg_latency: null, p95_latency: null });
      setRows([]);
      setCursor(null);
      setError(
        "선택한 기간에 해당하는 샤드가 없습니다. (샘플 데이터 날짜 범위를 확인하세요)"
      );
      return;
    }
    writeFilters(filters);

    const c = clientRef.current;
    const typedFilters = {
      from: filters.from,
      to: filters.to,
      q: filters.q || undefined,
      service: filters.service || undefined,
      level: filters.level || undefined,
      endpoint: filters.endpoint || undefined,
      statusMin: filters.statusMin ? Number(filters.statusMin) : undefined,
      statusMax: filters.statusMax ? Number(filters.statusMax) : undefined,
      latencyMin: filters.latencyMin ? Number(filters.latencyMin) : undefined,
      latencyMax: filters.latencyMax ? Number(filters.latencyMax) : undefined,
    };

    startTransition(() => {
      setError("");
      setRows([]);
      setCursor(null);
      setSummary(null);
    });
    (async () => {
      try {
        const [s, page] = await Promise.all([
          c.querySummary(shardFiles, typedFilters),
          c.queryPage(shardFiles, typedFilters, 200, null),
        ]);
        setSummary(s);
        setRows(page.rows);
        setCursor(page.nextCursor);
      } catch (e: any) {
        setError(e?.message ?? String(e));
      }
    })();
  }, [
    manifestReady,
    shardFiles.join("|"),
    filters.from,
    filters.to,
    filters.q,
    filters.service,
    filters.level,
    filters.endpoint,
    filters.statusMin,
    filters.statusMax,
    filters.latencyMin,
    filters.latencyMax,
  ]);

  const loadMore = async () => {
    if (!clientRef.current) return;
    if (!cursor) return;
    if (loadingMore) return;

    setLoadingMore(true);
    const c = clientRef.current;

    const typedFilters = {
      from: filters.from,
      to: filters.to,
      q: filters.q || undefined,
      service: filters.service || undefined,
      level: filters.level || undefined,
      endpoint: filters.endpoint || undefined,
      statusMin: filters.statusMin ? Number(filters.statusMin) : undefined,
      statusMax: filters.statusMax ? Number(filters.statusMax) : undefined,
      latencyMin: filters.latencyMin ? Number(filters.latencyMin) : undefined,
      latencyMax: filters.latencyMax ? Number(filters.latencyMax) : undefined,
    };

    try {
      const page = await c.queryPage(shardFiles, typedFilters, 200, cursor);
      setRows((prev) => [...prev, ...page.rows]);
      setCursor(page.nextCursor);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setLoadingMore(false);
    }
  };

  const onChange = <K extends keyof UrlFilters>(key: K, value: string) => {
    startTransition(() => {
      setFilters((prev) => ({ ...prev, [key]: value }));
    });
  };

  return (
    <div
      style={{
        padding: 16,
        fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Arial",
      }}
    >
      <h1 style={{ margin: 0 }}>Log Explorer</h1>
      <p style={{ marginTop: 6, color: "#555" }}>
        Static Parquet shards + DuckDB-Wasm (Worker) + Virtualized table
      </p>

      {!manifestReady && <div>Booting DuckDB & loading manifest…</div>}
      {error && (
        <div style={{ color: "crimson", marginTop: 8 }}>Error: {error}</div>
      )}

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          marginTop: 12,
          alignItems: "end",
        }}
      >
        <div>
          <div style={{ fontSize: 12, color: "#666" }}>From (ISO)</div>
          <input
            style={{ width: 260 }}
            value={filters.from}
            onChange={(e) => onChange("from", e.target.value)}
          />
        </div>
        <div>
          <div style={{ fontSize: 12, color: "#666" }}>To (ISO)</div>
          <input
            style={{ width: 260 }}
            value={filters.to}
            onChange={(e) => onChange("to", e.target.value)}
          />
        </div>
        <div>
          <div style={{ fontSize: 12, color: "#666" }}>Search (message)</div>
          <input
            style={{ width: 220 }}
            value={filters.q}
            onChange={(e) => onChange("q", e.target.value)}
          />
        </div>
        <div>
          <div style={{ fontSize: 12, color: "#666" }}>Service</div>
          <select
            value={filters.service}
            onChange={(e) => onChange("service", e.target.value)}
          >
            <option value="">All</option>
            <option value="api">api</option>
            <option value="web">web</option>
            <option value="worker">worker</option>
            <option value="billing">billing</option>
            <option value="search">search</option>
          </select>
        </div>
        <div>
          <div style={{ fontSize: 12, color: "#666" }}>Level</div>
          <select
            value={filters.level}
            onChange={(e) => onChange("level", e.target.value)}
          >
            <option value="">All</option>
            <option value="info">info</option>
            <option value="warn">warn</option>
            <option value="error">error</option>
          </select>
        </div>
        <div style={{ marginLeft: "auto", fontSize: 12, color: "#666" }}>
          {isPending ? "Updating…" : `Shards: ${shardFiles.length}`}
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, minmax(160px, 1fr))",
          gap: 10,
          marginTop: 12,
        }}
      >
        <Card
          title="Total"
          value={summary ? Number(summary.total).toLocaleString() : "—"}
        />
        <Card
          title="Errors"
          value={summary ? Number(summary.errors).toLocaleString() : "—"}
        />
        <Card
          title="Avg latency"
          value={
            summary?.avg_latency != null
              ? `${Number(summary.avg_latency).toFixed(1)}ms`
              : "—"
          }
        />
        <Card
          title="P95 latency"
          value={
            summary?.p95_latency != null
              ? `${Number(summary.p95_latency).toFixed(1)}ms`
              : "—"
          }
        />
      </div>

      <div
        style={{
          marginTop: 12,
          border: "1px solid #ddd",
          borderRadius: 10,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "140px 80px 70px 70px 90px 1fr",
            gap: 8,
            padding: "10px 12px",
            fontSize: 12,
            color: "#666",
            borderBottom: "1px solid #eee",
            background: "#fafafa",
          }}
        >
          <div>Time</div>
          <div>Service</div>
          <div>Level</div>
          <div>Status</div>
          <div>Latency</div>
          <div>Message</div>
        </div>

        <div style={{ height: "70vh" }}>
          <Virtuoso
            data={rows}
            endReached={loadMore}
            overscan={700}
            itemContent={(_, r) => (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "140px 80px 70px 70px 90px 1fr",
                  gap: 8,
                  padding: "10px 12px",
                  borderBottom: "1px solid #f0f0f0",
                  fontSize: 13,
                }}
              >
                <div
                  style={{
                    fontFamily:
                      "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
                    color: "#555",
                  }}
                >
                  {new Date(r.ts).toISOString().slice(11, 19)}
                </div>
                <div>{r.service}</div>
                <div style={{ fontWeight: r.level === "error" ? 700 : 400 }}>
                  {r.level}
                </div>
                <div>{r.status}</div>
                <div>{r.latency_ms}ms</div>
                <div
                  style={{
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {r.message}
                </div>
              </div>
            )}
            components={{
              Footer: () => (
                <div style={{ padding: 10, fontSize: 12, color: "#666" }}>
                  {loadingMore
                    ? "Loading…"
                    : cursor
                    ? "Scroll to load more"
                    : "End"}
                </div>
              ),
            }}
          />
        </div>
      </div>
    </div>
  );
};

const Card = ({ title, value }: { title: string; value: string }) => {
  return (
    <div style={{ border: "1px solid #ddd", borderRadius: 10, padding: 12 }}>
      <div style={{ fontSize: 12, color: "#666" }}>{title}</div>
      <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4 }}>{value}</div>
    </div>
  );
};

export default App;
