# 0001: Language models from Groq instead of Amazon Bedrock

**Status:** accepted, 2026-09 (fallback added 2026-11-07). Revisit when AWS unblocks Bedrock.

## Context

The specification named Amazon Bedrock as the only model provider and ruled out third-party model subscriptions. This AWS account cannot call Bedrock models. AWS Support confirmed this is an account-level restriction (a new account without billing history), not IAM or region. It was re-checked on 2026-11-07: the model list is visible, but every `Converse` call returns `ValidationException: Operation not allowed`, including Amazon's own Nova models.

## Decision

- Intent and the Explainer call Groq (`openai/gpt-oss-20b`, free tier) through `packages/llm`.
- If Groq fails or is rate-limited, `packages/llm` falls back to an OpenRouter free model (`openrouter/free`). Neither needs a payment method.
- The Broker embeds locally (`all-MiniLM-L6-v2`) instead of using Bedrock Titan.
- A Bedrock provider (`Converse`) is implemented and tested but switched off.

## Consequences

- The deviation from the specification must be disclosed in any academic write-up.
- Free tiers bring limits: Groq allows 200,000 tokens per day, and OpenRouter's free models are slow and capped, so the fallback is best effort (4 of 5 requests completed in the outage drill, see EVALUATION.md).
- Prompts go to third parties. For real pilot users this belongs in the consent form.
- Returning to Bedrock is a setting, `LLM_PROVIDERS=bedrock,groq,openrouter`, plus `bedrock:InvokeModel` on the two roles. Bedrock is paid per token (about $1 a month or less at pilot volume), which conflicts with the stay-free decision (DP2) and needs approval.
