export type Filters = {
  from: string;
  to: string;
  q: string;
  service: string;
  level: string;
  endpoint: string;
  statusMin: string;
  statusMax: string;
  latencyMin: string;
  latencyMax: string;
};

const keys = [
  "from",
  "to",
  "q",
  "service",
  "level",
  "endpoint",
  "statusMin",
  "statusMax",
  "latencyMin",
  "latencyMax",
] as const;

export const readFilters = (defaults: Filters): Filters => {
  const sp = new URLSearchParams(window.location.search);
  const next = { ...defaults };
  for (const k of keys) {
    const v = sp.get(k);
    if (v !== null) (next as any)[k] = v;
  }
  return next;
};

export const writeFilters = (f: Filters) => {
  const sp = new URLSearchParams();
  for (const k of keys) {
    const v = (f as any)[k];
    if (v) sp.set(k, String(v));
  }
  const url = `${window.location.pathname}?${sp.toString()}`;
  window.history.replaceState(null, "", url);
};
