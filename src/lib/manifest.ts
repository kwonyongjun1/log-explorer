export type Manifest = {
  version: number;
  schema: string[];
  shards: Array<{
    file: string;
    from: string;
    to: string;
    rows: number;
  }>;
};

export const assetUrl = (path: string) => {
  return new URL(
    path.replace(/^\//, ""),
    window.location.origin + import.meta.env.BASE_URL
  ).toString();
};

export const loadManifest = async (): Promise<Manifest> => {
  const res = await fetch(assetUrl("data/events/manifest.json"), {
    cache: "no-store",
  });
  if (!res.ok) throw new Error("Failed to load manifest.json");
  return res.json();
};

export const pickShards = (
  manifest: Manifest,
  fromISO: string,
  toISO: string
) => {
  const from = new Date(fromISO).getTime();
  const to = new Date(toISO).getTime();

  return manifest.shards
    .filter((s) => {
      const sFrom = new Date(s.from).getTime();
      const sTo = new Date(s.to).getTime();
      return sTo > from && sFrom < to;
    })
    .map((s) => s.file);
};
