export { validateService, type CatalogueServiceV2 } from "./schema";
export { sanitizeText, type SanitizeResult } from "./sanitize";
export { parseCsv, rowToService } from "./csv";
export { toV1, type ServiceV1 } from "./project";

import { validateService, type CatalogueServiceV2 } from "./schema";
import { sanitizeText } from "./sanitize";

export const NAME_MAX = 80;
export const DESCRIPTION_MAX = 300;

export interface IngestReport {
  accepted: CatalogueServiceV2[];
  rejected: { serviceId: string; problems: string[] }[];
  cleaned: { serviceId: string; field: string; changes: string[] }[];
}

// Sanitises the provider-written fields, validates each record and drops duplicates.
// Nothing enters the catalogue unchecked; everything changed or refused is reported.
export function ingest(records: CatalogueServiceV2[]): IngestReport {
  const report: IngestReport = { accepted: [], rejected: [], cleaned: [] };
  const seen = new Set<string>();
  for (const raw of records) {
    const s: CatalogueServiceV2 = { ...raw, pricing: { ...raw.pricing }, advertised: { ...raw.advertised }, source: { ...raw.source } };
    for (const [field, max] of [["name", NAME_MAX], ["provider", NAME_MAX], ["description", DESCRIPTION_MAX]] as const) {
      const out = sanitizeText(s[field], max);
      if (out.changes.length) report.cleaned.push({ serviceId: s.serviceId, field, changes: out.changes });
      s[field] = out.text;
    }
    const problems = validateService(s);
    if (seen.has(s.serviceId)) problems.push(`duplicate serviceId ${s.serviceId}`);
    if (problems.length) {
      report.rejected.push({ serviceId: s.serviceId, problems });
      continue;
    }
    seen.add(s.serviceId);
    report.accepted.push(s);
  }
  return report;
}
