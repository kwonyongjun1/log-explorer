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

type Cursor = { ts: string; id: number } | null;

type Ok = { ok: true; requestId: number; data: any };
type Err = { ok: false; requestId: number; error: string };

export class DuckClient {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: any) => void }
  >();

  constructor() {
    this.worker = new Worker(
      new URL("../workers/duckdb.worker.ts", import.meta.url),
      { type: "module" }
    );
    this.worker.onmessage = (ev: MessageEvent<Ok | Err>) => {
      const msg = ev.data;
      const p = this.pending.get(msg.requestId);
      if (!p) return;
      this.pending.delete(msg.requestId);

      if (msg.ok) p.resolve(msg.data);
      else p.reject(new Error(msg.error));
    };
  }

  private call(payload: any) {
    const requestId = this.nextId++;
    const p = new Promise<any>((resolve, reject) =>
      this.pending.set(requestId, { resolve, reject })
    );
    this.worker.postMessage({ ...payload, requestId });
    return p;
  }

  async init() {
    await this.call({ type: "init", baseUrl: import.meta.env.BASE_URL });
  }

  async querySummary(files: string[], filters: Filters) {
    return this.call({ type: "querySummary", files, filters });
  }

  async queryPage(
    files: string[],
    filters: Filters,
    limit: number,
    cursor?: Cursor
  ) {
    return this.call({
      type: "queryPage",
      files,
      filters,
      limit,
      cursor: cursor ?? undefined,
    });
  }

  dispose() {
    this.worker.terminate();
    this.pending.clear();
  }
}
