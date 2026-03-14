/**
 * seed.ts — Ingest participants.json, generate identity_md for each
 * participant via LLM, and create the data/ directory tree.
 * This is the first step: `npm run seed`.
 */

import type { Participant, ParticipantInput, SandboxState, RoomName } from "./types.js";
import { ROOM_NAMES, TOTAL_HACKATHON_MINUTES } from "./types.js";
import { buildSeedIdentityPrompt } from "./prompts.js";
import { parseSeedResponse } from "./actions.js";
import type { LLMProvider } from "./types.js";
import * as store from "./store.js";

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

const STARTING_ROOMS: RoomName[] = ["FRONT_GARDEN", "HALLWAY_1", "MAIN_ROOM", "HALLWAY_2", "KITCHEN", "BAR", "BACK_GARDEN"];

export async function seedSimulation(llm: LLMProvider): Promise<void> {
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
    const promises = batch.map(async (input, batchIdx) => {
      const idx = i + batchIdx;
      const id = slugify(input.name);
      const background = input.background || "";

      const { system, user } = buildSeedIdentityPrompt(input.name, background);

      let identity = `I am ${input.name}, a hackathon participant ready to build something great.`;
      let goal = "Build something impressive and win the hackathon.";

      try {
        const raw = await llm.generate(system, user);
        const parsed = parseSeedResponse(raw);
        if (parsed.identity) identity = parsed.identity;
        if (parsed.goal) goal = parsed.goal;
      } catch (err) {
        console.error(`  LLM failed for ${input.name}, using default identity`);
      }

      const room = STARTING_ROOMS[idx % STARTING_ROOMS.length]!;

      const participant: Participant = {
        id,
        name: input.name,
        background,
        identity_md: identity,
        goal,
        stats: { energy: 100, momentum: 50, morale: 80 },
        room,
        team_id: null,
        world_knowledge: [],
        history_summary: "",
      };

      store.saveParticipant(participant);
      store.archiveIdentity(id, 0, identity);
      console.log(`  [${idx + 1}/${inputs.length}] ${input.name} → ${room}`);
    });

    await Promise.all(promises);
  }

  console.log(`\nSeeded ${inputs.length} participants. Ready to run.`);
}
