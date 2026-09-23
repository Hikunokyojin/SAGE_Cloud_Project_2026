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
        evidence: [],
      },
      {
        serviceId: "svc-2",
        name: "BudgetResize",
        description: "Cheap image resizer",
        price: 0.01,
        uptime: 98.5,
        endpoint: "https://api.example.com/resize2",
        evidence: [],
      },
    ],
    constraints: [
      { field: "price", operator: "lte", value: 0.05, mandatory: true },
      { field: "uptime", operator: "gte", value: 95, mandatory: true },
    ],
    iteration: 1,
  });
  console.log(JSON.stringify(result, null, 2));
}

run().catch(console.error);
