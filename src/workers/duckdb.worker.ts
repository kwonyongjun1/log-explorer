/// <reference lib="webworker" />
import * as duckdb from "@duckdb/duckdb-wasm";
import duckdb_wasm from "@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url";
import mvp_worker from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url";
import duckdb_wasm_eh from "@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url";
import eh_worker from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url";

type Filters = {
  from?: string;
  to?: string;
  q?: string;
  service?: string;
  level?: string;
  endpoint?: string;
  statusMin?: number;
  statusMax?: number;
  latencyMin?: number;
  latencyMax?: number;
};

type InitMsg = { type: "init"; requestId: number; baseUrl: string };
type QueryPageMsg = {
  type: "queryPage";
  requestId: number;
  files: string[];
  filters: Filters;
  limit: number;
  cursor?: { ts: string; id: number }; // keyset cursor
};
type QuerySummaryMsg = {
  type: "querySummary";
  requestId: number;
  files: string[];
  filters: Filters;
};
type Msg = InitMsg | QueryPageMsg | QuerySummaryMsg;

type Ok = { ok: true; requestId: number; data: any };
type Err = { ok: false; requestId: number; error: string };

let db: duckdb.AsyncDuckDB | null = null;
let conn: duckdb.AsyncDuckDBConnection | null = null;
let baseUrl = "/";

const loaded = new Set<string>();

const BUNDLES: duckdb.DuckDBBundles = {
  mvp: { mainModule: duckdb_wasm, mainWorker: mvp_worker },
  eh: { mainModule: duckdb_wasm_eh, mainWorker: eh_worker },
};

const assetUrl = (path: string) => {
  return new URL(
    path.replace(/^\//, ""),
    self.location.origin + baseUrl
  ).toString();
};

const ensureDb = async () => {
  if (db && conn) return;
  const bundle = await duckdb.selectBundle(BUNDLES);
  const worker = new Worker(bundle.mainWorker!);
  const logger = new duckdb.ConsoleLogger();
  db = new duckdb.AsyncDuckDB(logger, worker);
  await db.instantiate(bundle.mainModule!);
  conn = await db.connect();
};

const ensureFiles = async (files: string[]) => {
  await ensureDb();
  if (!db) throw new Error("DuckDB not initialized");

  for (const f of files) {
    if (loaded.has(f)) continue;

    const url = assetUrl(`data/events/${f}`);
    const buf = new Uint8Array(await (await fetch(url)).arrayBuffer());

    await db.registerFileBuffer(f, buf);
    loaded.add(f);
  }
};

const buildWhere = (filters: Filters) => {
  const parts: string[] = ["1=1"];
  const esc = (s: string) => s.replace(/'/g, "''");

  if (filters.from) parts.push(`ts >= TIMESTAMP '${esc(filters.from)}'`);
  if (filters.to) parts.push(`ts < TIMESTAMP '${esc(filters.to)}'`);

  if (filters.service) parts.push(`service = '${esc(filters.service)}'`);
  if (filters.level) parts.push(`level = '${esc(filters.level)}'`);
  if (filters.endpoint) parts.push(`endpoint = '${esc(filters.endpoint)}'`);

  if (typeof filters.statusMin === "number")
    parts.push(`status >= ${filters.statusMin}`);
  if (typeof filters.statusMax === "number")
    parts.push(`status <= ${filters.statusMax}`);

  if (typeof filters.latencyMin === "number")
    parts.push(`latency_ms >= ${filters.latencyMin}`);
  if (typeof filters.latencyMax === "number")
    parts.push(`latency_ms <= ${filters.latencyMax}`);

  if (filters.q && filters.q.trim()) {
    const q = esc(filters.q.trim());
    parts.push(`message ILIKE '%${q}%'`);
  }

  return parts.join(" AND ");
};

const readParquetList = (files: string[]) => {
  const arr = files.map((f) => `'${f.replace(/'/g, "''")}'`).join(",");
  return `read_parquet([${arr}])`;
};

const queryPage = async (msg: QueryPageMsg) => {
  await ensureFiles(msg.files);
  if (!conn) throw new Error("No connection");

  const where = buildWhere(msg.filters);
  const cursorClause = msg.cursor
    ? ` AND (ts < TIMESTAMP '${msg.cursor.ts.replace(
        /'/g,
        "''"
      )}' OR (ts = TIMESTAMP '${msg.cursor.ts.replace(/'/g, "''")}' AND id < ${
        msg.cursor.id
      }))`
    : "";

  const sql = `
    SELECT id, ts, service, level, status, latency_ms, endpoint, trace_id, region, message
    FROM ${readParquetList(msg.files)}
    WHERE ${where}${cursorClause}
    ORDER BY ts DESC, id DESC
    LIMIT ${msg.limit}
  `;

  const result = await conn.query(sql);
  const rows = (result.toArray() as any[]).map((r) => {
    const o = typeof r?.toJSON === "function" ? r.toJSON() : r;

    return {
      id: Number(o.id),
      ts: new Date(o.ts).toISOString(),
      service: String(o.service),
      level: String(o.level),
      status: Number(o.status),
      latency_ms: Number(o.latency_ms),
      endpoint: String(o.endpoint),
      trace_id: String(o.trace_id),
      region: String(o.region),
      message: String(o.message),
    };
  });
  const last = rows.length ? rows[rows.length - 1] : null;
  const nextCursor = last
    ? { ts: new Date(last.ts).toISOString(), id: Number(last.id) }
    : null;

  return { rows, nextCursor };
};

const querySummary = async (msg: QuerySummaryMsg) => {
  await ensureFiles(msg.files);
  if (!conn) throw new Error("No connection");

  const where = buildWhere(msg.filters);

  const sql = `
    SELECT
      count(*)::BIGINT AS total,
      sum(CASE WHEN level='error' THEN 1 ELSE 0 END)::BIGINT AS errors,
      avg(latency_ms)::DOUBLE AS avg_latency,
      quantile_cont(latency_ms, 0.95)::DOUBLE AS p95_latency
    FROM ${readParquetList(msg.files)}
    WHERE ${where}
  `;

  const result = await conn.query(sql);
  const [r] = result.toArray() as any[];

  if (!r) return { total: 0, errors: 0, avg_latency: null, p95_latency: null };

  const o = typeof r?.toJSON === "function" ? r.toJSON() : r;

  return {
    total: Number(o.total ?? 0),
    errors: Number(o.errors ?? 0),
    avg_latency: o.avg_latency == null ? null : Number(o.avg_latency),
    p95_latency: o.p95_latency == null ? null : Number(o.p95_latency),
  };
};

self.onmessage = async (ev: MessageEvent<Msg>) => {
  const msg = ev.data;
  try {
    if (msg.type === "init") {
      baseUrl = msg.baseUrl || "/";
      await ensureDb();
      const out: Ok = {
        ok: true,
        requestId: msg.requestId,
        data: { ready: true },
      };
      self.postMessage(out);
      return;
    }

    if (msg.files.length === 0) {
      return msg.type === "queryPage"
        ? { rows: [], nextCursor: null }
        : { total: 0, errors: 0, avg_latency: null, p95_latency: null };
    }

    if (msg.type === "queryPage") {
      const data = await queryPage(msg);
      const out: Ok = { ok: true, requestId: msg.requestId, data };
      self.postMessage(out);
      return;
    }

    if (msg.type === "querySummary") {
      const data = await querySummary(msg);
      const out: Ok = { ok: true, requestId: msg.requestId, data };
      self.postMessage(out);
      return;
    }
  } catch (e: any) {
    const out: Err = {
      ok: false,
      requestId: (msg as any).requestId,
      error: e?.message ?? String(e),
    };
    self.postMessage(out);
  }
};
