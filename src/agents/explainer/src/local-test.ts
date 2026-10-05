import { handler } from "./index";

async function run() {
  const result = await handler({
    requestId: "test-explainer-1",
    composition: {
      requestId: "test-explainer-1",
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
      alternatives: [
        {
          service: {
            serviceId: "svc-2",
            name: "BudgetResize",
            description: "Cheap image resizer",
            price: 0.01,
            uptime: 98.5,
            endpoint: "https://api.example.com/resize2",
            evidence: [],
          },
          score: 0.64,
          reason: "price=0.01, uptime=98.5%",
        },
      ],
      iteration: 1,
      scoreBreakdown: {
        requestId: "test-explainer-1",
        candidateId: "svc-1",
        dimensions: { price: 1, uptime: 1, capability: 1 },
        weights: { price: 1, uptime: 1, capability: 0.5 },
        totalScore: 0.87,
        constraintStatus: "pass",
        violatedConstraints: [],
      },
    },
  });
  console.log(JSON.stringify(result, null, 2));
}

run().catch(console.error);
