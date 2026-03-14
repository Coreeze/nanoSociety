/**
 * nanosociety.ts — Entry point for the nanoSociety hackathon simulator.
 * Three modes:
 *   --seed    Ingest participants.json, generate identities, create data/
 *   --run     Run the simulation (default)
 *   --analyze Generate post-simulation report
 */

import "dotenv/config";
import { createLLMProvider } from "./src/llm.js";
import { seedSimulation } from "./src/seed.js";
import { runSimulation } from "./src/engine.js";
import { runAnalysis } from "./src/analyzer.js";

const args = process.argv.slice(2);
const mode = args.includes("--seed") ? "seed" : args.includes("--analyze") ? "analyze" : "run";

async function main(): Promise<void> {
  const llm = createLLMProvider();

  switch (mode) {
    case "seed":
      await seedSimulation(llm);
      break;
    case "run":
      await runSimulation(llm);
      break;
    case "analyze":
      await runAnalysis(llm);
      break;
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
