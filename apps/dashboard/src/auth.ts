// Pilot sign-in against Cognito (T2.1), without an SDK: one InitiateAuth call with
// USER_PASSWORD_AUTH. The ID token goes in the Authorization header of /pilot/* calls,
// which API Gateway's Cognito authorizer checks. Kept in sessionStorage only, so it is
// gone when the tab closes.

export interface CognitoConfig {
  region: string;
  clientId: string;
}

export interface Session {
  idToken: string;
  email: string;
  expiresAt: number;
}

export function initiateAuthRequest(cfg: CognitoConfig, email: string, password: string): { url: string; init: RequestInit } {
  return {
    url: `https://cognito-idp.${cfg.region}.amazonaws.com/`,
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.1",
        "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth",
      },
      body: JSON.stringify({
        AuthFlow: "USER_PASSWORD_AUTH",
        ClientId: cfg.clientId,
        AuthParameters: { USERNAME: email, PASSWORD: password },
      }),
    },
  };
}

// Turns Cognito's reply into a session, or throws a message a person can act on.
export function parseAuthResponse(status: number, body: any, email: string, now = Date.now()): Session {
  if (status !== 200) {
    const type = String(body?.__type ?? "");
    if (type.includes("NotAuthorizedException") || type.includes("UserNotFoundException")) {
      throw new Error("Wrong email or password.");
    }
    if (type.includes("PasswordResetRequiredException")) throw new Error("A password reset is required; ask the operator.");
    throw new Error(body?.message ?? `Sign-in failed (HTTP ${status}).`);
  }
  if (body?.ChallengeName) {
    throw new Error("This account still has a temporary password; ask the operator to set a permanent one.");
  }
  const result = body?.AuthenticationResult;
  if (!result?.IdToken) throw new Error("Sign-in failed: no token returned.");
  return { idToken: result.IdToken, email, expiresAt: now + (result.ExpiresIn ?? 3600) * 1000 };
}

export function isValid(session: Session | null, now = Date.now()): session is Session {
  return !!session && session.expiresAt - 30_000 > now;
}

// Pilot requests go through the authorised route; everyone else uses the public demo.
export function requestUrl(apiBase: string, session: Session | null, now = Date.now()): string {
  const base = apiBase.replace(/\/$/, "");
  return isValid(session, now) ? `${base}/pilot/request` : `${base}/request`;
}

export function requestHeaders(session: Session | null, now = Date.now()): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (isValid(session, now)) h.Authorization = session.idToken;
  return h;
}

const KEY = "sage.pilotSession";
export function loadSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}
export function saveSession(s: Session | null): void {
  try {
    if (s) sessionStorage.setItem(KEY, JSON.stringify(s));
    else sessionStorage.removeItem(KEY);
  } catch {
    // storage unavailable: the session just lasts until reload
  }
}
