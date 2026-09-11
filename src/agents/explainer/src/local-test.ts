import { handler } from "./index";

async function run() {
  const result = await handler({
    requestId: "test-explainer-1",
    blueprint: {
      requestId: "test-explainer-1",
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
      alternatives: [
        {
          service: {
            serviceId: "svc-2",
            name: "BudgetResize",
            description: "Cheap image resizer",
            price: 0.01,
            uptime: 98.5,
            endpoint: "https://api.example.com/resize2",
          },
          score: 0.64,
          reason: "price=0.01, uptime=98.5%",
        },
      ],
    },
  });
  console.log(JSON.stringify(result, null, 2));
}

run().catch(console.error);
