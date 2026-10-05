import { handler } from "./index";

async function run() {
  const result = await handler({
    requestId: "test-reviewer-1",
    composition: {
      requestId: "test-reviewer-1",
      chosen: {
        service: {
          serviceId: "svc-1",
          name: "FastResize",
          description: "Quick image resizer",
          price: 0.02,
          uptime: 99.9,
          endpoint: "https://api.example.com/resize",
          evidence: [],
        },
        score: 0.87,
        reason: "price=0.02, uptime=99.9%",
      },
      alternatives: [],
      iteration: 1,
      scoreBreakdown: {
        requestId: "test-reviewer-1",
        candidateId: "svc-1",
        dimensions: { price: 1, uptime: 1, capability: 1 },
        weights: { price: 1, uptime: 1, capability: 0.5 },
        totalScore: 0.87,
        constraintStatus: "pass",
        violatedConstraints: [],
      },
    },
    constraints: [
      { field: "price", operator: "lte", value: 0.05, mandatory: true },
      { field: "uptime", operator: "gte", value: 95, mandatory: true },
    ],
  });
  console.log(JSON.stringify(result, null, 2));
}

run().catch(console.error);
