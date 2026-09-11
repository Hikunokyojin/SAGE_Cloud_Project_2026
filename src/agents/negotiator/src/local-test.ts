import { handler } from "./index";

async function run() {
  const result = await handler({
    requestId: "test-negotiator-1",
    candidates: [
      {
        serviceId: "svc-1",
        name: "FastResize",
        description: "Quick image resizer",
        price: 0.02,
        uptime: 99.9,
        endpoint: "https://api.example.com/resize",
      },
      {
        serviceId: "svc-2",
        name: "BudgetResize",
        description: "Cheap image resizer",
        price: 0.01,
        uptime: 98.5,
        endpoint: "https://api.example.com/resize2",
      },
    ],
    constraints: { maxBudget: 0.05, minUptime: 95 },
  });
  console.log(JSON.stringify(result, null, 2));
}

run().catch(console.error);
