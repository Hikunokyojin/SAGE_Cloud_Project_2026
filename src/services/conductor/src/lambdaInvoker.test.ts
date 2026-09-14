import { describe, it, expect, vi, beforeEach } from "vitest";

const sendMock = vi.fn();

vi.mock("@aws-sdk/client-lambda", () => {
  class LambdaClient {
    send = sendMock;
  }
  class InvokeCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  return { LambdaClient, InvokeCommand };
});

function lambdaSuccessResponse(payload: unknown) {
  const body = JSON.stringify(payload);
  return { StatusCode: 200, Payload: new TextEncoder().encode(body) };
}

describe("lambdaInvoker", () => {
  beforeEach(() => {
    sendMock.mockReset();
    process.env.INPUT_GUARD_FUNCTION_NAME = "sage-input-guard";
    process.env.INTENT_FUNCTION_NAME = "sage-intent";
    process.env.BROKER_FUNCTION_NAME = "sage-broker";
    process.env.NEGOTIATOR_FUNCTION_NAME = "sage-negotiator";
    process.env.REVIEWER_FUNCTION_NAME = "sage-reviewer";
    process.env.EXPLAINER_FUNCTION_NAME = "sage-explainer";
    process.env.ESCALATION_EXPLAINER_FUNCTION_NAME = "sage-escalation-explainer";
  });

  it("invokes the configured function name with the given payload and returns the parsed result", async () => {
    sendMock.mockResolvedValue(
      lambdaSuccessResponse({
        requestId: "req-1",
        rawInput: "hello",
        sanitizedInput: "hello",
        flagged: false,
        detectedPatterns: [],
      })
    );

    const { lambdaInvoker } = await import("./lambdaInvoker");
    const result = await lambdaInvoker.inputGuard({ requestId: "req-1", rawInput: "hello" });

    expect(result.sanitizedInput).toBe("hello");
    const invokeCommand = sendMock.mock.calls[0][0];
    expect(invokeCommand.input.FunctionName).toBe("sage-input-guard");
    expect(JSON.parse(invokeCommand.input.Payload)).toEqual({ requestId: "req-1", rawInput: "hello" });
  });

  it("routes each AgentInvoker method to its own configured Lambda function name", async () => {
    sendMock.mockResolvedValue(lambdaSuccessResponse({}));

    const { lambdaInvoker } = await import("./lambdaInvoker");
    await lambdaInvoker.intent({ requestId: "req-1", rawInput: "hello" });
    await lambdaInvoker.broker({ requestId: "req-1", capability: "x", constraints: {} });

    expect(sendMock.mock.calls[0][0].input.FunctionName).toBe("sage-intent");
    expect(sendMock.mock.calls[1][0].input.FunctionName).toBe("sage-broker");
  });

  it("throws a descriptive error when the Lambda invocation itself reports a function error", async () => {
    sendMock.mockResolvedValue({
      StatusCode: 200,
      FunctionError: "Unhandled",
      Payload: new TextEncoder().encode(JSON.stringify({ errorMessage: "boom" })),
    });

    const { lambdaInvoker } = await import("./lambdaInvoker");
    await expect(lambdaInvoker.intent({ requestId: "req-1", rawInput: "hello" })).rejects.toThrow(
      /sage-intent.*boom/
    );
  });

  it("throws a descriptive error when the required function-name env var is missing", async () => {
    delete process.env.INTENT_FUNCTION_NAME;

    const { lambdaInvoker } = await import("./lambdaInvoker");
    await expect(lambdaInvoker.intent({ requestId: "req-1", rawInput: "hello" })).rejects.toThrow(
      "INTENT_FUNCTION_NAME"
    );
  });
});
