// Pre-downloads the embedding model's ONNX weights into
// node_modules/@huggingface/transformers/.cache/ (the library's own default cache
// location) so the Lambda deployment package can bundle that whole folder and never
// depend on live internet access to huggingface.co during a demo. Run once locally
// (needs internet access); re-run only if the model name changes.
const { pipeline } = require("@huggingface/transformers");

async function main() {
  console.log("Downloading Xenova/all-MiniLM-L6-v2 (this populates the local .cache, run once)...");
  await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
  console.log("Done. Model cached under node_modules/@huggingface/transformers/.cache/");
}

main().catch((err) => {
  console.error("Model download failed:", err);
  process.exit(1);
});
