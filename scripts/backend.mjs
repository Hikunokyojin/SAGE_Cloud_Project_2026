#!/usr/bin/env node
// Pause or resume the live backend (the Conductor's EC2 instance) to control cost.
//
//   npm run backend:status
//   npm run backend:pause     stop the instance (no compute charge while stopped)
//   npm run backend:resume    start it again and wait until /health answers
//
// The dashboard is hosted separately (GitHub Pages) and stays up while the backend is
// paused; it detects the missing backend and shows a "paused to save cost" notice.
// Requires the AWS CLI with credentials that may describe, start and stop EC2 instances.

import { execFileSync } from "node:child_process";

const REGION = process.env.AWS_REGION || "ap-south-1";
const INSTANCE_NAME = "SageStack/Conductor/ConductorInstance";
const API_URL = (process.env.SAGE_API_URL || "https://hiz4sheyl5.execute-api.ap-south-1.amazonaws.com/prod").replace(/\/$/, "");
const HEALTH_TIMEOUT_MS = 5 * 60 * 1000;

function aws(args) {
  try {
    return execFileSync("aws", [...args, "--region", REGION, "--output", "json"], { encoding: "utf8" });
  } catch (err) {
    const detail = err.stderr ? String(err.stderr).trim() : err.message;
    console.error(`AWS CLI call failed (aws ${args.slice(0, 2).join(" ")}):\n${detail}`);
    process.exit(1);
  }
}

function findInstance() {
  const out = JSON.parse(
    aws([
      "ec2",
      "describe-instances",
      "--filters",
      `Name=tag:Name,Values=${INSTANCE_NAME}`,
      "Name=instance-state-name,Values=pending,running,stopping,stopped",
    ])
  );
  const instances = out.Reservations.flatMap((r) => r.Instances);
  if (instances.length !== 1) {
    console.error(`Expected exactly one Conductor instance named "${INSTANCE_NAME}" in ${REGION}, found ${instances.length}.`);
    process.exit(1);
  }
  const i = instances[0];
  return { id: i.InstanceId, state: i.State.Name, publicIp: i.PublicIpAddress ?? "none" };
}

async function backendHealthy() {
  try {
    const res = await fetch(`${API_URL}/health`, { signal: AbortSignal.timeout(8000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitUntilHealthy() {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  process.stdout.write("Waiting for the backend to answer /health");
  while (Date.now() < deadline) {
    if (await backendHealthy()) {
      console.log("\nBackend is online.");
      return true;
    }
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, 10_000));
  }
  console.log("\nTimed out; the instance is running but /health has not answered yet. Check again in a minute.");
  return false;
}

function status() {
  const inst = findInstance();
  console.log(`Conductor ${inst.id}: ${inst.state} (public IP: ${inst.publicIp})`);
  return inst;
}

async function main() {
  const command = process.argv[2];
  if (command === "status") {
    const inst = status();
    console.log(`Backend /health: ${(await backendHealthy()) ? "ok" : "not answering"}${inst.state === "stopped" ? " (paused)" : ""}`);
  } else if (command === "pause") {
    const inst = status();
    if (inst.state === "stopped") return console.log("Already paused.");
    aws(["ec2", "stop-instances", "--instance-ids", inst.id]);
    console.log("Stopping the instance...");
    aws(["ec2", "wait", "instance-stopped", "--instance-ids", inst.id]);
    console.log("Paused. Compute charges stop; the Elastic IP is still billed while allocated (see docs/OPERATIONS.md).");
  } else if (command === "resume") {
    const inst = status();
    if (inst.state !== "running") {
      aws(["ec2", "start-instances", "--instance-ids", inst.id]);
      console.log("Starting the instance...");
      aws(["ec2", "wait", "instance-running", "--instance-ids", inst.id]);
    }
    process.exit((await waitUntilHealthy()) ? 0 : 2);
  } else {
    console.log("Usage: node scripts/backend.mjs <status|pause|resume>");
    process.exit(1);
  }
}

main();
