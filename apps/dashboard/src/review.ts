// The human review page (T2.3). The alert email links to
//   <dashboard>#review=<requestId>&token=<signed token>
// and this module reads that link and builds the two Conductor calls the page makes.

export interface ReviewLink {
  requestId: string;
  token: string;
}

export interface Constraint {
  field: "price" | "uptime" | "latencyMs";
  operator: "lt" | "lte" | "gt" | "gte" | "eq";
  value: number;
  mandatory: boolean;
  priority?: number;
}

export interface OfferedService {
  serviceId: string;
  name: string;
  price: number;
  uptime: number;
  latencyMs?: number;
}

export interface PausedRequest {
  requestId: string;
  status: "pending" | "approved" | "rejected" | "rerun";
  reason: string;
  intent: { capability: string; category?: string; constraints: Constraint[]; rawInput: string };
  candidates: OfferedService[];
  escalation: { explanation: string };
  createdAt: string;
  resolution?: { action: string; reviewer: string; note?: string; serviceId?: string; resolvedAt: string };
}

export interface ResolveBody {
  action: "approve" | "reject" | "relax";
  reviewer: string;
  note?: string;
  serviceId?: string;
  constraints?: Constraint[];
}

export function parseReviewHash(hash: string): ReviewLink | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const requestId = params.get("review");
  const token = params.get("token");
  return requestId && token ? { requestId, token } : null;
}

const base = (apiBase: string) => apiBase.replace(/\/$/, "");

export function viewRequest(apiBase: string, link: ReviewLink): { url: string } {
  return { url: `${base(apiBase)}/requests/${encodeURIComponent(link.requestId)}?token=${encodeURIComponent(link.token)}` };
}

export function resolveRequest(apiBase: string, link: ReviewLink, body: ResolveBody): { url: string; init: RequestInit } {
  return {
    url: `${base(apiBase)}/requests/${encodeURIComponent(link.requestId)}/resolve`,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: link.token, ...body }),
    },
  };
}
