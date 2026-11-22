"""RT10: cost per 1,000 requests, from the live trial of 2026-11-22.

Run from the sage folder:  python -I evaluation/cost/rt10_cost.py
Writes evaluation/results/rt10-cost.json.

Measured inputs (51 requests: the 50 in results/rt7-raw.json plus one check call just before):
- Lambda: invocations and billed duration per function, summed from the CloudWatch REPORT
  lines for 10:27:30 to 10:34:00 UTC (this also includes a few keep-warm pings, so it slightly
  overstates the per-request figure).
- DynamoDB: the 304 audit records the 50 requests wrote, sized item by item (write request
  units = ceil(item size / 1 KB) per record).
- Model tokens: the `usage` field of every Intent and Explainer audit record.

Prices: AWS on-demand list prices for ap-south-1 read from the AWS Price List API on
2026-11-22. The Groq price is its published on-demand price for openai/gpt-oss-20b, an
assumption to check before quoting: the deployment runs on Groq's free tier and is billed $0.
"""
import json
import pathlib

OUT = pathlib.Path(__file__).resolve().parents[1] / "results" / "rt10-cost.json"

REQUESTS = 51
LAMBDA = {  # function: (invocations, billed ms, memory MB)
    "sage-input-guard": (53, 896, 512),
    "sage-intent": (53, 16702, 512),
    "sage-broker": (61, 16148, 1769),
    "sage-negotiator": (52, 1589, 512),
    "sage-reviewer": (52, 1625, 512),
    "sage-explainer": (52, 31452, 512),
    "sage-unsatisfiable-escalation": (2, 85, 512),
    "sage-escalation-explainer": (2, 98, 512),
}
AUDIT = {"requests": 50, "records": 304, "write_units": 2663}
TOKENS = {  # agent: (calls, prompt tokens, completion tokens), over the 50 trial requests
    "IntentAgent": (9, 13392, 953),
    "ExplainerAgent": (49, 16011, 7146),
}

PRICE = {
    "lambda_gb_s": 0.0000166667,
    "lambda_request": 0.0000002,
    "apigw_rest_request": 0.0000035,
    "ddb_write_unit": 0.00000071,
    "ec2_t3_micro_hour": 0.0112,
    "groq_input_token": 0.075 / 1e6,
    "groq_output_token": 0.30 / 1e6,
}


def main() -> None:
    gb_s = sum(ms / 1000 * mb / 1024 for _, ms, mb in LAMBDA.values())
    invocations = sum(n for n, _, _ in LAMBDA.values())
    lam = (gb_s * PRICE["lambda_gb_s"] + invocations * PRICE["lambda_request"]) / REQUESTS
    api = PRICE["apigw_rest_request"]
    ddb = AUDIT["write_units"] / AUDIT["requests"] * PRICE["ddb_write_unit"]

    def model(intent_calls_per_request: float) -> float:
        ic, ip, io = TOKENS["IntentAgent"]
        ec, ep, eo = TOKENS["ExplainerAgent"]
        intent = intent_calls_per_request * (ip / ic * PRICE["groq_input_token"] + io / ic * PRICE["groq_output_token"])
        explain = (ep * PRICE["groq_input_token"] + eo * PRICE["groq_output_token"]) / AUDIT["requests"]
        return intent + explain

    trial = model(TOKENS["IntentAgent"][0] / AUDIT["requests"])
    uncached = model(1.0)
    per_k = lambda x: round(x * 1000, 4)
    ec2_month = PRICE["ec2_t3_micro_hour"] * 730
    result = {
        "requests_measured": REQUESTS,
        "per_1000_requests_usd": {
            "lambda": per_k(lam),
            "api_gateway": per_k(api),
            "dynamodb_audit_writes": per_k(ddb),
            "language_model_this_trial": per_k(trial),
            "language_model_no_intent_cache": per_k(uncached),
            "variable_total_this_trial": per_k(lam + api + ddb + trial),
            "variable_total_no_intent_cache": per_k(lam + api + ddb + uncached),
        },
        "fixed_per_month_usd": {
            "ec2_t3_micro_conductor": round(ec2_month, 2),
            "qdrant_mongodb": 0.0,
        },
        "intent_cache_hit_rate_this_trial": round(1 - TOKENS["IntentAgent"][0] / AUDIT["requests"], 2),
        "billed_today_usd": "0 (AWS free tier, Groq free tier, Qdrant and MongoDB free clusters)",
        "notes": [
            "Lambda billed duration includes a few keep-warm pings in the window.",
            "The Groq price is a list-price assumption; the deployment is billed nothing on the free tier.",
            "The EC2 Conductor is a fixed cost: at 10,000 requests a month it adds about $0.82 per 1,000.",
        ],
        "prices": PRICE,
    }
    OUT.write_text(json.dumps(result, indent=1) + "\n", encoding="utf-8")
    print(json.dumps(result["per_1000_requests_usd"], indent=1))
    print(json.dumps(result["fixed_per_month_usd"]))


if __name__ == "__main__":
    main()
