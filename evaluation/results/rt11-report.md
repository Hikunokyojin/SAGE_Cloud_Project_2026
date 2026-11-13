# RT11: multi-service composition (T4.1f)

Run 2026-11-13T11:36:03.933Z against the live API. **26 of 30 passed.** Cases rt11-12,14,22,25,30 failed on the Groq free-tier limit (8,000 tokens/min) at a 4 s gap and were re-run at a 20 s gap; the re-run result is recorded.

Sandbox endpoints are a local stub per catalogue category (stand-ins for provider test modes).

| Case | Expected | Status | Steps | Total price | Uptime | Latency | Result |
|---|---|---|---|---|---|---|---|
| rt11-01 | approved | completed | Google Cloud Vision OCR > Amazon Translate | $157.5 | 99.8161% | 1548 | pass |
| rt11-02 | approved | completed | Google Cloud Speech-to-Text > Amazon Comprehend Entities | $17 | 99.8161% | 1461 | pass |
| rt11-03 | approved | completed | Google Cloud Storage Standard > ImageKit | $11.6 | 99.862% | 993 | pass |
| rt11-04 | approved | completed | Stripe Payments > Mailgun | $220 | 99.982% | 1319 | pass |
| rt11-05 | approved | completed | WorkOS AuthKit > Telnyx Messaging | $42.5 | 99.99% | 877 | pass |
| rt11-06 | approved | paused_for_review | - | - | - | - | FAIL: no chain was approved (status paused_for_review) |
| rt11-07 | approved | completed | Stripe Radar > Stripe Payments | $52 | 99.982% | 679 | pass |
| rt11-08 | approved | completed | Upstash QStash > Brevo Transactional Email | $8.5 | 99.899% | 1996 | pass |
| rt11-09 | approved | completed | Amazon Rekognition Image > MongoDB Atlas Flex | $18 | 99.862% | 2285 | pass |
| rt11-10 | approved | completed | PDFShift > SendGrid Email API | $28.95 | 99.862% | 1070 | pass |
| rt11-11 | approved | completed | Bunny Stream > Bunny CDN | $1.5 | 99.982% | 880 | pass |
| rt11-12 | approved | completed | Voyage AI Embeddings > Algolia Search | $50.6 | 99.899% | 720 | pass |
| rt11-13 | approved | completed | MaxMind GeoIP2 Precision > PostHog | $60 | 99.899% | 1206 | pass |
| rt11-14 | approved | paused_for_review | - | - | - | - | FAIL: no chain was approved (status paused_for_review) |
| rt11-15 | approved | completed | Fireworks AI > Telnyx Messaging | $40.5 | 99.907% | 916 | pass |
| rt11-16 | approved | completed | Google Cloud Vision OCR > Amazon Comprehend Entities | $16 | 99.8161% | 1232 | pass |
| rt11-17 | approved | completed | AssemblyAI > Azure AI Translator > Google Cloud Text-to-Speech | $16.5 | 99.7243% | 1921 | pass |
| rt11-18 | approved | completed | WorkOS AuthKit > Google Cloud Storage Standard > Mailgun | $185.1 | 99.936% | 1567 | pass |
| rt11-19 | approved | completed | Stripe Radar > Stripe Payments > Mailgun | $232 | 99.973% | 1697 | pass |
| rt11-20 | approved | completed | Google Cloud Storage Standard > Cloudflare Images > Bunny CDN | $8.6 | 99.945% | 1089 | pass |
| rt11-21 | approved | completed | Upstash QStash > Azure Logic Apps (Consumption) | $3.5 | 99.899% | 844 | pass |
| rt11-22 | approved | completed | Azure Key Vault (Standard) > Amazon API Gateway REST API | $0.65 | 99.945% | 988 | pass |
| rt11-23 | approved | completed | Vercel > Sentry | $46 | 99.899% | 649 | pass |
| rt11-24 | approved | completed | - | - | - | - | FAIL: no chain was approved (status completed) |
| rt11-25 | approved | completed | Algolia Recommend > Mailgun | $240 | 99.982% | 1278 | pass |
| rt11-26 | approved | paused_for_review | - | - | - | - | FAIL: no chain was approved (status paused_for_review) |
| rt11-27 | approved | completed | Cloudflare Images > Sightengine | $34 | 99.908% | 1182 | pass |
| rt11-28 | refused | paused_for_review | - | - | - | - | pass |
| rt11-29 | refused | paused_for_review | - | - | - | - | pass |
| rt11-30 | refused | paused_for_review | - | - | - | - | pass |
