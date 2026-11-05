import { describe, it, expect } from "vitest";
import { initiateAuthRequest, parseAuthResponse, requestUrl, requestHeaders, isValid } from "./auth";

const cfg = { region: "ap-south-1", clientId: "abc123" };

describe("pilot sign-in", () => {
  it("builds a Cognito InitiateAuth call with USER_PASSWORD_AUTH", () => {
    const { url, init } = initiateAuthRequest(cfg, "a@b.c", "pw");
    expect(url).toBe("https://cognito-idp.ap-south-1.amazonaws.com/");
    expect((init.headers as Record<string, string>)["X-Amz-Target"]).toBe("AWSCognitoIdentityProviderService.InitiateAuth");
    expect(JSON.parse(init.body as string)).toEqual({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: "abc123",
      AuthParameters: { USERNAME: "a@b.c", PASSWORD: "pw" },
    });
  });

  it("turns a successful reply into a session that expires", () => {
    const s = parseAuthResponse(200, { AuthenticationResult: { IdToken: "tok", ExpiresIn: 3600 } }, "a@b.c", 1000);
    expect(s).toEqual({ idToken: "tok", email: "a@b.c", expiresAt: 1000 + 3600_000 });
    expect(isValid(s, 2000)).toBe(true);
    expect(isValid(s, 1000 + 3600_000)).toBe(false);
  });

  it("gives a plain message for a wrong password and for a temporary password", () => {
    expect(() => parseAuthResponse(400, { __type: "NotAuthorizedException" }, "a")).toThrow("Wrong email or password.");
    expect(() => parseAuthResponse(200, { ChallengeName: "NEW_PASSWORD_REQUIRED" }, "a")).toThrow(/temporary password/);
  });

  it("sends signed-in requests to the protected route with the token, others to the public demo", () => {
    const s = { idToken: "tok", email: "a", expiresAt: 10_000_000 };
    expect(requestUrl("https://x/prod/", s, 0)).toBe("https://x/prod/pilot/request");
    expect(requestHeaders(s, 0).Authorization).toBe("tok");
    expect(requestUrl("https://x/prod", null, 0)).toBe("https://x/prod/request");
    expect(requestHeaders(null, 0).Authorization).toBeUndefined();
  });
});
