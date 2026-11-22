// RT11 (T4.1f): 30 multi-service requests. 27 can be met by the live catalogue; 3 state
// limits no chain can meet, so the right outcome is a pause for human review.
import type { Rt11Case } from "./check";

export const RT11_CASES: Rt11Case[] = [
  { id: "rt11-01", text: "Extract text from about 5,000 scanned invoice pages a month, then translate that text into Spanish. Keep the whole thing under $200 a month.", steps: ["document-ocr", "translation"], limits: { price: 200 } },
  { id: "rt11-02", text: "Transcribe our support call recordings, then run sentiment analysis on the transcripts. Total budget $300 a month.", steps: ["speech-transcription", "text-analysis"], limits: { price: 300 } },
  { id: "rt11-03", text: "Store user-uploaded photos in object storage and resize each one into thumbnails. Keep the total under $100 a month.", steps: ["object-storage", "image-resizing"], limits: { price: 100 } },
  { id: "rt11-04", text: "Take card payments for our shop and send an email receipt after each payment. Combined uptime of at least 99.5%.", steps: ["payment-processing", "email-delivery"], limits: { uptime: 99.5 } },
  { id: "rt11-05", text: "Sign users in with a managed authentication service, then send them a welcome SMS. Total under $150 a month.", steps: ["authentication", "messaging"], limits: { price: 150 } },
  { id: "rt11-06", text: "Translate product descriptions into French and then convert them to speech audio. Keep the total under $250 a month.", steps: ["translation", "text-to-speech"], limits: { price: 250 } },
  { id: "rt11-07", text: "Screen each card payment for fraud first, then process the payment. The two together must have at least 99% uptime.", steps: ["fraud-detection", "payment-processing"], limits: { uptime: 99 } },
  { id: "rt11-08", text: "Put incoming orders on a message queue, then send an email confirmation for each order. Total budget $80 a month.", steps: ["message-queue", "email-delivery"], limits: { price: 80 } },
  { id: "rt11-09", text: "Analyse uploaded images to detect objects, then store the results in a managed database. Total under $200 a month.", steps: ["image-analysis", "database"], limits: { price: 200 } },
  { id: "rt11-10", text: "Generate PDF invoices from HTML and email them to customers. Keep the total under $120 a month.", steps: ["document-generation", "email-delivery"], limits: { price: 120 } },
  { id: "rt11-11", text: "Transcode uploaded videos for streaming and serve them through a content delivery network. Total under $500 a month.", steps: ["video-transcoding", "content-delivery"], limits: { price: 500 } },
  { id: "rt11-12", text: "Generate text embeddings for our help articles, then index them in a full-text search service. Total under $150 a month.", steps: ["embedding-generation", "full-text-search"], limits: { price: 150 } },
  { id: "rt11-13", text: "Look up each visitor's location from their IP address, then record it in product analytics. Total budget $100 a month.", steps: ["geolocation", "product-analytics"], limits: { price: 100 } },
  { id: "rt11-14", text: "Stream clickstream events through a data streaming service and query them with an SQL query service. Total under $300 a month.", steps: ["data-streaming", "data-query"], limits: { price: 300 } },
  { id: "rt11-15", text: "Run ML model inference on each request, then send the prediction as a push or SMS message. Total under $250 a month.", steps: ["ml-inference", "messaging"], limits: { price: 250 } },
  { id: "rt11-16", text: "Extract text from scanned contracts with OCR, then run text analysis to pull out key entities. Total under $250 a month.", steps: ["document-ocr", "text-analysis"], limits: { price: 250 } },
  { id: "rt11-17", text: "Transcribe podcast audio, translate the transcript into German, then turn it into speech. Total under $400 a month.", steps: ["speech-transcription", "translation", "text-to-speech"], limits: { price: 400 } },
  { id: "rt11-18", text: "Authenticate users, store their files in object storage, and email them when an upload finishes. Total under $200 a month.", steps: ["authentication", "object-storage", "email-delivery"], limits: { price: 200 } },
  { id: "rt11-19", text: "Check each payment for fraud, process it, then email a receipt. All three together need at least 99% combined uptime.", steps: ["fraud-detection", "payment-processing", "email-delivery"], limits: { uptime: 99 } },
  { id: "rt11-20", text: "Store product images in object storage, resize them, and serve them through a CDN. Total budget $150 a month.", steps: ["object-storage", "image-resizing", "content-delivery"], limits: { price: 150 } },
  { id: "rt11-21", text: "Queue incoming jobs in a message queue, then orchestrate them with a workflow orchestration service. Total under $100 a month.", steps: ["message-queue", "workflow-orchestration"], limits: { price: 100 } },
  { id: "rt11-22", text: "Keep API keys in a secrets manager and expose our backend through an API gateway. Total under $60 a month.", steps: ["secrets-management", "api-gateway"], limits: { price: 60 } },
  { id: "rt11-23", text: "Host our web app on a web hosting service and monitor it with a monitoring service. Total under $100 a month.", steps: ["web-hosting", "monitoring"], limits: { price: 100 } },
  { id: "rt11-24", text: "Run our containers on a compute service pulled from a container registry. Total under $300 a month.", steps: ["container-registry", "compute"], limits: { price: 300 } },
  { id: "rt11-25", text: "Generate product recommendations for each user, then email them a weekly digest. Total under $300 a month.", steps: ["recommendations", "email-delivery"], limits: { price: 300 } },
  { id: "rt11-26", text: "Transcribe customer voicemails and then send each transcript to the team by email. Total under $100 a month.", steps: ["speech-transcription", "email-delivery"], limits: { price: 100 } },
  { id: "rt11-27", text: "Resize uploaded images and then analyse them to detect unsafe content. Keep combined uptime at least 99%.", steps: ["image-resizing", "image-analysis"], limits: { uptime: 99 } },
  // Infeasible: limits no combination in the catalogue can meet.
  { id: "rt11-28", text: "Transcribe 10,000 minutes of audio a month and translate the transcripts into Spanish. Total under $1 a month.", steps: ["speech-transcription", "translation"], limits: { price: 1 }, expect: "refused" },
  { id: "rt11-29", text: "Process card payments and send an SMS confirmation, with at least 99.999% combined uptime.", steps: ["payment-processing", "messaging"], limits: { uptime: 99.999 }, expect: "refused" },
  { id: "rt11-30", text: "Transcode video and serve it through a CDN, total under $0.50 a month.", steps: ["video-transcoding", "content-delivery"], limits: { price: 0.5 }, expect: "refused" },
];
