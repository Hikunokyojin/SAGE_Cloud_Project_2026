import { handler } from "./index";

async function run() {
  const result = await handler({
    requestId: "test-reviewer-1",
    blueprint: {
      requestId: "test-reviewer-1",
      chosen: {
        service: {
          serviceId: "svc-1",
          name: "FastResize",
          description: "Quick image resizer",
          price: 0.02,
          uptime: 99.9,
          endpoint: "https://api.example.com/resize",
        },
        score: 0.87,
        reason: "price=0.02, uptime=99.9%",
      },
      alternatives: [],
    },
    constraints: { maxBudget: 0.05, minUptime: 95 },
    attempt: 1,
  });
  console.log(JSON.stringify(result, null, 2));
}

run().catch(console.error);
