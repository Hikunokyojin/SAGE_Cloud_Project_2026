// Chooses Broker's similarity cut-off from labelled queries.
//
//   npx tsx evaluation/src/retrieval/calibrate.ts
//
// Embeds the catalogue (same text as scripts/reembed-services.ts: "name: description")
// and each labelled query with the same local model as the Broker, then sweeps the
// threshold. Needs no Qdrant or MongoDB: cosine similarity on normalised vectors is
// what Qdrant computes. Writes results/retrieval-calibration.json.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";
import { curve, chooseThreshold, thresholdGrid, cosine, type ScoredQuery } from "./calibration";

const ROOT = join(__dirname, "..", "..", "..");

interface Service { serviceId: string; name: string; description: string; capability: string }

async function main() {
  // --v2: the real catalogue (T3.4), synthetic records excluded, with the 35-category query set.
  const v2 = process.argv.includes("--v2");
  const services: Service[] = v2
    ? JSON.parse(readFileSync(join(ROOT, "data", "services.v2.json"), "utf-8")).filter((s: { synthetic?: boolean }) => !s.synthetic)
    : JSON.parse(readFileSync(join(ROOT, "data", "services.json"), "utf-8"));
  const labelled: { in: [string, string][]; out: string[] } = JSON.parse(
    readFileSync(join(__dirname, v2 ? "labelled-queries.v2.json" : "labelled-queries.json"), "utf-8")
  );

  const make = pipeline as (task: string, model: string) => Promise<FeatureExtractionPipeline>;
  const extractor = await make("feature-extraction", "Xenova/all-MiniLM-L6-v2");
  const embed = async (t: string) => Array.from((await extractor(t, { pooling: "mean", normalize: true })).data as Float32Array);

  const svcVectors = await Promise.all(services.map(async (s) => ({ s, v: await embed(`${s.name}: ${s.description}`) })));

  const scored: (ScoredQuery & { query: string; category?: string })[] = [];
  for (const [category, query] of labelled.in) {
    const q = await embed(query);
    const inCat = svcVectors.filter((x) => x.s.capability === category).map((x) => cosine(q, x.v));
    scored.push({ kind: "in", best: Math.max(...inCat), query, category });
  }
  for (const query of labelled.out) {
    const q = await embed(query);
    scored.push({ kind: "out", best: Math.max(...svcVectors.map((x) => cosine(q, x.v))), query });
  }

  const points = curve(scored, thresholdGrid());
  const chosen = chooseThreshold(points, 0.95);
  // The Broker's live cut-off (agents/broker/src/index.ts MIN_SIMILARITY).
  const current = points.find((p) => p.threshold === 0.38);

  const out = {
    generatedAt: new Date().toISOString(),
    model: "Xenova/all-MiniLM-L6-v2",
    inCatalogueQueries: labelled.in.length,
    outOfCatalogueQueries: labelled.out.length,
    current,
    chosen,
    scores: scored.map((q) => ({ ...q, best: Math.round(q.best * 1000) / 1000 })),
    curve: points,
  };
  mkdirSync(join(ROOT, "results"), { recursive: true });
  writeFileSync(join(ROOT, "results", v2 ? "retrieval-calibration-v2.json" : "retrieval-calibration.json"), JSON.stringify(out, null, 2) + "\n");
  console.log(`${services.length} services; current 0.38:`, current);
  console.log("chosen:", chosen);
  const worstIn = scored.filter((q) => q.kind === "in").sort((a, b) => a.best - b.best).slice(0, 5);
  const bestOut = scored.filter((q) => q.kind === "out").sort((a, b) => b.best - a.best).slice(0, 5);
  console.log("lowest in-catalogue:", worstIn.map((q) => `${q.best.toFixed(3)} ${q.query}`));
  console.log("highest out-of-catalogue:", bestOut.map((q) => `${q.best.toFixed(3)} ${q.query}`));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
