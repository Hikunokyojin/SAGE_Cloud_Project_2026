import { describe, it, expect, vi, beforeEach } from "vitest";

const sendMock = vi.fn();

vi.mock("@aws-sdk/client-ssm", () => {
  class SSMClient {
    send = sendMock;
  }
  class GetParameterCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  return { SSMClient, GetParameterCommand };
});

describe("resolveSecret", () => {
  beforeEach(() => {
    sendMock.mockReset();
    delete process.env.TEST_SECRET_ENV;
  });

  it("returns the value from the local environment variable when set, without calling SSM", async () => {
    process.env.TEST_SECRET_ENV = "local-value";

    const { resolveSecret } = await import("./index");
    const result = await resolveSecret("TEST_SECRET_ENV", "/sage/test/SECRET");

    expect(result).toBe("local-value");
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("falls back to SSM Parameter Store with decryption when the env var is not set", async () => {
    sendMock.mockResolvedValue({ Parameter: { Value: "ssm-value" } });

    const { resolveSecret } = await import("./index");
    const result = await resolveSecret("TEST_SECRET_ENV", "/sage/test/SECRET");

    expect(result).toBe("ssm-value");
    expect(sendMock).toHaveBeenCalledTimes(1);
    const command = sendMock.mock.calls[0][0];
    expect(command.input).toEqual({ Name: "/sage/test/SECRET", WithDecryption: true });
  });

  it("throws a descriptive error when the SSM parameter is missing or empty", async () => {
    sendMock.mockResolvedValue({ Parameter: { Value: undefined } });

    const { resolveSecret } = await import("./index");
    await expect(resolveSecret("TEST_SECRET_ENV", "/sage/test/SECRET")).rejects.toThrow(
      "/sage/test/SECRET not found or empty"
    );
  });
});
