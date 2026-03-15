/**
 * seed.ts — Ingest participants.json, generate identity_md for each
 * participant via LLM, and create the data/ directory tree.
 * This is the first step: `npm run seed`.
 */

import fs from "node:fs";
import path from "node:path";
import type { Participant, ParticipantInput, SandboxState, RoomName } from "./types.js";
import { ROOM_NAMES, TOTAL_HACKATHON_MINUTES } from "./types.js";
import { buildBatchSeedPrompt } from "./prompts.js";
import { parseBatchSeedResponse } from "./actions.js";
import type { LLMProvider } from "./types.js";
import * as store from "./store.js";

function wipeSimulationData(): void {
  const dataDir = path.resolve("data");
  for (const sub of ["beings", "teams", "analysis"]) {
    const dir = path.join(dataDir, sub);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  const sandbox = path.join(dataDir, "sandbox.json");
  if (fs.existsSync(sandbox)) fs.unlinkSync(sandbox);
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

const STARTING_ROOMS: RoomName[] = ["FRONT_GARDEN", "HALLWAY_1", "MAIN_ROOM", "HALLWAY_2", "KITCHEN", "BAR", "BACK_GARDEN"];

export async function seedSimulation(llm: LLMProvider): Promise<void> {
  console.log("Wiping previous simulation data...");
  wipeSimulationData();
  store.ensureDataDirs();

  const inputs = store.loadParticipantsInput();
  console.log(`Seeding ${inputs.length} participants...`);

  const minutesPerTick = parseInt(process.env.MINUTES_PER_TICK ?? "5", 10);
  const totalTicks = Math.ceil(TOTAL_HACKATHON_MINUTES / minutesPerTick);

  const sandbox: SandboxState = {
    tick: 0,
    minutesPerTick,
    totalTicks,
    events: [],
  };
  store.saveSandbox(sandbox);

  const batchSize = 10;
  for (let i = 0; i < inputs.length; i += batchSize) {
    const batch = inputs.slice(i, i + batchSize);
    const batchInputs = batch.map(input => ({
      name: input.name,
      background: input.background || "",
    }));

    const { system, user } = buildBatchSeedPrompt(batchInputs);
    const maxTokens = Math.min(2048, 80 * batch.length);

    let results: Map<string, { identity: string; goal: string }>;
    try {
      const raw = await llm.generate(system, user, maxTokens);
      results = parseBatchSeedResponse(raw, batch.map(b => b.name));
    } catch (err) {
      console.error(`  LLM failed for batch ${i / batchSize + 1}, using default identities`);
      results = new Map(batch.map(b => [b.name, {
        identity: `I am ${b.name}, a hackathon participant ready to build something great.`,
        goal: "Build something impressive and win the hackathon.",
      }]));
    }

    for (let batchIdx = 0; batchIdx < batch.length; batchIdx++) {
      const input = batch[batchIdx]!;
      const idx = i + batchIdx;
      const id = slugify(input.name);
      const background = input.background || "";
      const seed = results.get(input.name) ?? {
        identity: `I am ${input.name}, a hackathon participant ready to build something great.`,
        goal: "Build something impressive and win the hackathon.",
      };

      const room = STARTING_ROOMS[idx % STARTING_ROOMS.length]!;

      const participant: Participant = {
        id,
        name: input.name,
        background,
        identity_md: seed.identity,
        goal: seed.goal,
        stats: { energy: 100, momentum: 50, morale: 80 },
        room,
        team_id: null,
        world_knowledge: [],
        history_summary: "",
      };

      store.saveParticipant(participant);
      store.archiveIdentity(id, 0, seed.identity);
      console.log(`  [${idx + 1}/${inputs.length}] ${input.name} → ${room}`);
    }
  }

  console.log(`\nSeeded ${inputs.length} participants. Ready to run.`);
}
