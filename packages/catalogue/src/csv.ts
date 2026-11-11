// Reads the curation sheet (T3.2) exported as CSV, one service per row.
//
// Columns: serviceId, name, provider, description, capability, endpoint, price, priceUnit,
// currency, priceNotes, uptime, latencyMs, sourceUrl, retrievedAt, terms.
import type { CatalogueServiceV2 } from "./schema";

// RFC 4180-style: quoted fields may contain commas, line breaks and doubled quotes.
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  // A leading byte-order mark (spreadsheet exports often add one), built from its code point.
  const src = text.startsWith(String.fromCharCode(0xfeff)) ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...body] = rows.filter((r) => r.some((f) => f.trim() !== ""));
  if (!header) return [];
  const keys = header.map((h) => h.trim());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()])));
}

const toNumber = (v: string | undefined): number => (v === undefined || v === "" ? NaN : Number(v));

export function rowToService(r: Record<string, string>): CatalogueServiceV2 {
  const latency = toNumber(r.latencyMs);
  return {
    serviceId: r.serviceId,
    name: r.name,
    provider: r.provider,
    description: r.description,
    capability: r.capability,
    endpoint: r.endpoint,
    pricing: {
      amount: toNumber(r.price),
      unit: r.priceUnit,
      currency: (r.currency || "USD").toUpperCase(),
      ...(r.priceNotes ? { notes: r.priceNotes } : {}),
    },
    advertised: { uptime: toNumber(r.uptime), ...(Number.isFinite(latency) ? { latencyMs: latency } : {}) },
    source: { url: r.sourceUrl, retrievedAt: r.retrievedAt, ...(r.terms ? { terms: r.terms } : {}) },
  };
}
