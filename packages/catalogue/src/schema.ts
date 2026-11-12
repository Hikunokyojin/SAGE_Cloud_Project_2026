// Catalogue schema v2 (T3.1). Every service records where its numbers came from and when,
// keeps advertised and measured quality apart, and notes the source's terms, so a real
// catalogue can be audited and refreshed.
import { SERVICE_CATEGORIES } from "@sage/shared-types";

export interface CatalogueServiceV2 {
  // Lower-case, digits and hyphens, starting "svc-".
  serviceId: string;
  name: string;
  provider: string;
  // Provider-written text, sanitised on ingestion (see sanitize.ts).
  description: string;
  // One of SERVICE_CATEGORIES.
  capability: string;
  // HTTPS base URL of the API.
  endpoint: string;
  // Where the QoS probe (T3.3) checks reachability when `endpoint` is per-customer (for example
  // Azure's <account>.blob.core.windows.net) and has no shared host to call. Defaults to endpoint.
  probeUrl?: string;
  pricing: {
    amount: number;
    // What the amount is for, for example "per email" or "per GB-month".
    unit: string;
    // ISO 4217, upper case.
    currency: string;
    notes?: string;
  };
  // From the provider's SLA or documentation.
  advertised: { uptime: number; latencyMs?: number };
  // From our own probes (T3.3); preferred over advertised values when present.
  measured?: { uptime: number; latencyMs?: number; sampledAt: string; samples: number };
  source: {
    url: string;
    // YYYY-MM-DD.
    retrievedAt: string;
    // Licence or terms-of-use note for the source page.
    terms?: string;
  };
  // True for the original made-up services, until they are replaced by real ones.
  synthetic?: boolean;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function isHttpsUrl(s: unknown): boolean {
  try {
    return typeof s === "string" && new URL(s).protocol === "https:";
  } catch {
    return false;
  }
}

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

// Returns every problem found (empty means valid), each naming the field.
export function validateService(s: CatalogueServiceV2): string[] {
  const p: string[] = [];
  if (!/^svc-[a-z0-9-]{2,60}$/.test(s.serviceId ?? "")) p.push(`serviceId "${s.serviceId}" must look like svc-lowercase-name`);
  if (!s.name?.trim()) p.push("name is required");
  if (!s.provider?.trim()) p.push("provider is required");
  if (!s.description?.trim()) p.push("description is required");
  if (!(SERVICE_CATEGORIES as readonly string[]).includes(s.capability)) {
    p.push(`capability "${s.capability}" is not one of SERVICE_CATEGORIES (add the category there first)`);
  }
  if (!isHttpsUrl(s.endpoint)) p.push(`endpoint "${s.endpoint}" must be an https URL`);
  if (s.probeUrl !== undefined && !isHttpsUrl(s.probeUrl)) p.push(`probeUrl "${s.probeUrl}" must be an https URL`);
  if (!num(s.pricing?.amount) || s.pricing.amount < 0) p.push("pricing.amount must be a number of at least 0");
  if (!s.pricing?.unit?.trim()) p.push("pricing.unit is required (for example \"per email\")");
  if (!/^[A-Z]{3}$/.test(s.pricing?.currency ?? "")) p.push("pricing.currency must be a 3-letter upper-case code (for example USD)");
  if (!num(s.advertised?.uptime) || s.advertised.uptime < 0 || s.advertised.uptime > 100) p.push("advertised.uptime must be a percentage from 0 to 100");
  if (s.advertised?.latencyMs !== undefined && (!num(s.advertised.latencyMs) || s.advertised.latencyMs <= 0)) {
    p.push("advertised.latencyMs must be a positive number when given");
  }
  if (s.measured) {
    if (!num(s.measured.uptime) || s.measured.uptime < 0 || s.measured.uptime > 100) p.push("measured.uptime must be a percentage from 0 to 100");
    if (!DATE.test(s.measured.sampledAt ?? "")) p.push("measured.sampledAt must be YYYY-MM-DD");
  }
  if (!isHttpsUrl(s.source?.url)) p.push(`source.url "${s.source?.url}" must be an https URL`);
  if (!DATE.test(s.source?.retrievedAt ?? "")) p.push(`source.retrievedAt "${s.source?.retrievedAt}" must be YYYY-MM-DD`);
  return p;
}
