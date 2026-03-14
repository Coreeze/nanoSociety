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
import { startServer } from "./src/server.js";

const args = process.argv.slice(2);
const mode = args.includes("--seed") ? "seed" : args.includes("--analyze") ? "analyze" : "run";

function getPort(): number {
  const idx = args.indexOf("--port");
  if (idx !== -1 && args[idx + 1]) return parseInt(args[idx + 1], 10);
  return parseInt(process.env.PORT ?? "3000", 10);
}

async function main(): Promise<void> {
  const llm = createLLMProvider();

  switch (mode) {
    case "seed":
      await seedSimulation(llm);
      break;
    case "run":
      startServer(getPort());
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
