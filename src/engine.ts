/**
 * engine.ts — The heartbeat loop for nanoSociety.
 * Hybrid tick system: autopilot ticks use pre-baked narratives for speed,
 * LLM ticks fire real model calls for pivotal decisions (team formation,
 * creative moments). Phase C self-eval is batched. Drama events inject chaos.
 */

import type {
  LLMProvider, Participant, Team, SandboxState,
  ScheduleBlock, SimEvent, PhaseName, RoomName,
} from './types.js';
import { SCHEDULE, HACKATHON_START_HOUR, TOTAL_HACKATHON_MINUTES } from './types.js';
import * as store from './store.js';
import {
  parseBatchActionResponse, parseBatchTeamResponse,
  parseBatchSelfEvalResponse,
  applyAction, applyTeamAction, applyStatChanges,
} from './actions.js';
import {
  buildBatchActionPrompt, buildBatchTeamPrompt,
  buildBatchSelfEvalPrompt,
} from './prompts.js';
import { generateAutopilotAction, isLLMTick, rollDrama } from './autopilot.js';
import type { LogEntry } from './renderer.js';
import { broadcast, broadcastProgress, waitForStart } from './server.js';

// ── Time Utilities ────────────────────────────────────────────────────────

function tickToMinutes(tick: number, minutesPerTick: number): number {
  return tick * minutesPerTick;
}

function minutesToClock(minutes: number): string {
  const totalMinutes = minutes + HACKATHON_START_HOUR * 60;
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h > 12 ? h - 12 : h === 0 ? 12 : h;
  return `${h12}:${m.toString().padStart(2, '0')} ${period}`;
}

function getPhase(minutes: number): ScheduleBlock {
  for (const block of SCHEDULE) {
    if (minutes >= block.startMinute && minutes < block.endMinute) {
      return block;
    }
  }
  return SCHEDULE[SCHEDULE.length - 1]!;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// ── Engine ────────────────────────────────────────────────────────────────

export async function runSimulation(llm: LLMProvider): Promise<void> {
  const sandbox = store.loadSandbox();
  const tickInterval = parseInt(process.env.TICK_INTERVAL_MS ?? '0', 10);
  const selfEvalInterval = parseInt(process.env.SELF_EVAL_INTERVAL ?? '12', 10);
  const llmTickInterval = parseInt(process.env.LLM_TICK_INTERVAL ?? '3', 10);
  const selfEvalBatchSize = parseInt(process.env.SELF_EVAL_BATCH_SIZE ?? '25', 10);

  const recentLogs: LogEntry[] = [];
  const statSnapshots = new Map<string, { energy: number; momentum: number; morale: number }>();

  process.on('SIGINT', () => {
    console.log('\nSimulation interrupted. State saved.');
    process.exit(0);
  });

  const participants0 = store.loadAllParticipants();
  const teams0 = store.loadAllTeams();
  const minutes0 = tickToMinutes(sandbox.tick, sandbox.minutesPerTick);
  const phase0 = getPhase(minutes0);
  broadcast({
    tick: sandbox.tick,
    totalTicks: sandbox.totalTicks,
    time: minutesToClock(minutes0),
    phase: phase0.phase,
    participants: participants0,
    teams: teams0,
    recentLogs: [],
  });

  console.log('  Waiting for start command from UI...');
  await waitForStart();
  console.log('  Simulation started!');

  try {
    for (let tick = sandbox.tick + 1; tick <= sandbox.totalTicks; tick++) {
      const tickStart = Date.now();
      const minutes = tickToMinutes(tick, sandbox.minutesPerTick);
      const time = minutesToClock(minutes);
      const phase = getPhase(minutes);

      let participants = store.loadAllParticipants();
      let teams = store.loadAllTeams();
      const soloCount = participants.filter(p => !p.team_id).length;
      const useLLM = isLLMTick(tick, phase.phase, llmTickInterval);

      console.log(`\n── TICK ${tick}/${sandbox.totalTicks} ── ${time} ── ${phase.phase} ── ${useLLM ? 'LLM' : 'AUTO'} ── T:${teams.length} S:${soloCount} P:${participants.length} ──`);

      if (phase.forceRoom) {
        console.log(`  Force room: ${phase.forceRoom}`);
        for (const p of participants) {
          p.room = phase.forceRoom;
          store.saveParticipant(p);
        }
      }

      // ── Drama Event Roll ─────────────────────────────────────────
      const drama = rollDrama();
      if (drama) {
        console.log(`  🎲 DRAMA: ${drama.description}`);
        sandbox.events.push({ tick, time, type: 'drama', description: drama.description });
        recentLogs.push({
          name: '🎲 EVENT',
          action: drama.description.slice(0, 80),
          actionType: 'drama' as any,
          teamId: null,
        });
        for (const p of participants) {
          p.stats.energy = clamp(p.stats.energy + drama.energy, 0, 100);
          p.stats.momentum = clamp(p.stats.momentum + drama.momentum, 0, 100);
          p.stats.morale = clamp(p.stats.morale + drama.morale, 0, 100);
          store.saveParticipant(p);
        }
      }

      // ── Phase A + B: LLM or Autopilot ────────────────────────────

      if (useLLM) {
        broadcastProgress(`Tick ${tick}/${sandbox.totalTicks} — LLM processing...`);
        await Promise.all([
          runPhaseA_LLM(llm, participants, teams, phase, time, tick, sandbox, recentLogs),
          runPhaseB_LLM(llm, participants, teams, phase, time, tick, sandbox, recentLogs),
        ]);
      } else {
        broadcastProgress(`Tick ${tick}/${sandbox.totalTicks} — autopilot...`);
        runAutopilotTick(participants, teams, phase, time, tick, sandbox, recentLogs);
      }

      participants = store.loadAllParticipants();
      teams = store.loadAllTeams();

      // ── Phase C: Batched Self-eval + mutation ────────────────────

      if (tick % selfEvalInterval === 0 && tick > 0) {
        console.log(`  Phase C: batched self-eval (${participants.length} participants, batches of ${selfEvalBatchSize})`);
        broadcastProgress(`Phase C: self-eval for ${participants.length} participants...`);

        const phaseCStart = Date.now();
        let mutationCount = 0;

        const batches: Participant[][] = [];
        for (let i = 0; i < participants.length; i += selfEvalBatchSize) {
          batches.push(participants.slice(i, i + selfEvalBatchSize));
        }

        const batchPromises = batches.map(async (batch) => {
          const logsMap = new Map<string, unknown[]>();
          const statsBeforeMap = new Map<string, { energy: number; momentum: number; morale: number }>();
          for (const p of batch) {
            logsMap.set(p.id, store.readActionLog(p.id));
            statsBeforeMap.set(p.id, statSnapshots.get(p.id) ?? { energy: 100, momentum: 50, morale: 80 });
          }

          const maxTokens = Math.min(4096, 100 * batch.length);

          try {
            const { system, user } = buildBatchSelfEvalPrompt(batch, logsMap, statsBeforeMap);
            const raw = await llm.generate(system, user, maxTokens);
            const batchResults = parseBatchSelfEvalResponse(raw, batch.map(p => p.name));

            for (const p of batch) {
              const parsed = batchResults.get(p.name);
              if (!parsed) continue;

              p.world_knowledge.push(...parsed.learnings);
              if (p.world_knowledge.length > 20) {
                p.world_knowledge = p.world_knowledge.slice(-20);
              }

              store.appendEvalLog(p.id, {
                tick,
                progress: parsed.progress,
                learnings: parsed.learnings,
                changes: parsed.changes,
                stats: { ...p.stats },
              });

              if (parsed.newIdentity) {
                store.archiveIdentity(p.id, tick, p.identity_md);
                p.identity_md = parsed.newIdentity;
                mutationCount++;

                sandbox.events.push({
                  tick, time, type: 'mutation',
                  description: `${p.name}: ${parsed.changes}`,
                });

                recentLogs.push({
                  name: p.name,
                  action: `IDENTITY EVOLVED: ${parsed.changes.slice(0, 60)}`,
                  actionType: 'mutation',
                  teamId: p.team_id,
                });
              }

              store.saveParticipant(p);
            }
          } catch (err: any) {
            console.log(`    Phase C batch FAILED — ${err?.message?.slice(0, 80) ?? 'unknown error'}`);
          }
        });

        await Promise.all(batchPromises);
        console.log(`  Phase C done: ${mutationCount} mutations (${Date.now() - phaseCStart}ms)`);

        for (const p of store.loadAllParticipants()) {
          statSnapshots.set(p.id, { ...p.stats });
        }
      }

      // ── Render + Save ───────────────────────────────────────────

      participants = store.loadAllParticipants();
      teams = store.loadAllTeams();

      sandbox.tick = tick;
      store.saveSandbox(sandbox);

      broadcast({
        tick,
        totalTicks: sandbox.totalTicks,
        time,
        phase: phase.phase,
        participants,
        teams,
        recentLogs: recentLogs.slice(-30),
      });

      if (recentLogs.length > 50) recentLogs.splice(0, recentLogs.length - 30);

      const elapsed = Date.now() - tickStart;
      console.log(`  Tick ${tick} complete (${elapsed}ms total)`);

      if (tickInterval > 0) await sleep(tickInterval);
    }
  } finally {
    // no cleanup needed
  }

  console.log('\n════════════════════════════════════════════════════════');
  console.log('  SIMULATION COMPLETE');
  console.log(`  ${sandbox.totalTicks} ticks  │  ${sandbox.events.length} events logged`);
  console.log('  Run: npm run analyze');
  console.log('════════════════════════════════════════════════════════\n');
}

// ── Phase A: LLM batched by room ────────────────────────────────────────

async function runPhaseA_LLM(
  llm: LLMProvider,
  participants: Participant[],
  teams: Team[],
  phase: ScheduleBlock,
  time: string,
  tick: number,
  sandbox: SandboxState,
  recentLogs: LogEntry[],
): Promise<void> {
  const solos = participants.filter(p => !p.team_id);
  if (solos.length === 0 || phase.phase === 'KEYNOTE') return;

  const byRoom = new Map<RoomName, Participant[]>();
  for (const p of solos) {
    if (!byRoom.has(p.room)) byRoom.set(p.room, []);
    byRoom.get(p.room)!.push(p);
  }

  console.log(`  Phase A: ${solos.length} solos across ${byRoom.size} rooms`);
  const phaseAStart = Date.now();

  const roomPromises = Array.from(byRoom.entries()).map(async ([room, roomSolos]) => {
    const roomStart = Date.now();
    const logsMap = new Map<string, unknown[]>();
    for (const p of roomSolos) {
      logsMap.set(p.id, store.readActionLog(p.id));
    }

    const maxTokens = Math.min(4096, 150 * roomSolos.length);

    try {
      const { system, user } = buildBatchActionPrompt(roomSolos, phase, time, participants, teams, logsMap);
      const raw = await llm.generate(system, user, maxTokens);
      const batchResults = parseBatchActionResponse(raw, roomSolos.map(p => p.name));

      let parsed_count = 0;
      for (const p of roomSolos) {
        const parsed = batchResults.get(p.name);
        if (!parsed) continue;
        parsed_count++;

        const result = applyAction(p, parsed, participants, teams, tick, time);
        store.saveParticipant(p);
        store.appendActionLog(p.id, {
          tick, time, action_type: parsed.footer.ACTION,
          room: p.room, narrative: parsed.narrative,
          stats: { ...p.stats },
        });

        recentLogs.push({
          name: p.name,
          action: parsed.narrative.slice(0, 80),
          actionType: parsed.footer.ACTION,
          teamId: p.team_id,
        });

        if (result.newTeam) {
          store.saveTeam(result.newTeam);
          teams.push(result.newTeam);
        }
        for (const evt of result.events) {
          sandbox.events.push(evt);
        }
      }

      console.log(`    ✓ ${room}: ${parsed_count}/${roomSolos.length} parsed (${Date.now() - roomStart}ms)`);
    } catch (err: any) {
      console.log(`    ✗ ${room}: FAILED — ${err?.message?.slice(0, 80) ?? 'unknown error'} (${Date.now() - roomStart}ms)`);
    }
  });

  await Promise.all(roomPromises);
  console.log(`  Phase A done (${Date.now() - phaseAStart}ms)`);
}

// ── Phase B: LLM batched teams ──────────────────────────────────────────

async function runPhaseB_LLM(
  llm: LLMProvider,
  participants: Participant[],
  teams: Team[],
  phase: ScheduleBlock,
  time: string,
  tick: number,
  sandbox: SandboxState,
  recentLogs: LogEntry[],
): Promise<void> {
  const activeTeams = teams.filter(t => {
    const members = participants.filter(p => p.team_id === t.id);
    return members.length > 0;
  });
  if (activeTeams.length === 0 || phase.phase === 'KEYNOTE') return;

  console.log(`  Phase B: ${activeTeams.length} teams`);
  const phaseBStart = Date.now();

  const membersMap = new Map<string, Participant[]>();
  const logsMap = new Map<string, unknown[]>();
  for (const team of activeTeams) {
    const members = participants.filter(p => p.team_id === team.id);
    membersMap.set(team.id, members);
    logsMap.set(team.id, store.readActionLog(team.members[0]!));
  }

  const maxTokens = Math.min(4096, 200 * activeTeams.length);

  try {
    const { system, user } = buildBatchTeamPrompt(activeTeams, membersMap, phase, time, teams, logsMap);
    const raw = await llm.generate(system, user, maxTokens);
    const batchResults = parseBatchTeamResponse(raw, activeTeams.map(t => t.name));

    for (const team of activeTeams) {
      const parsed = batchResults.get(team.name);
      if (!parsed) continue;

      const members = membersMap.get(team.id) ?? [];
      const events = applyTeamAction(team, parsed, members, tick, time);

      store.saveTeam(team);
      for (const member of members) {
        store.saveParticipant(member);
        store.appendActionLog(member.id, {
          tick, time, action_type: `team:${parsed.footer.ACTION}`,
          room: member.room, narrative: parsed.narrative,
          stats: { ...member.stats },
        });
      }

      recentLogs.push({
        name: team.name,
        action: parsed.narrative.slice(0, 80),
        actionType: `team:${parsed.footer.ACTION}`,
        teamId: team.id,
      });

      for (const evt of events) {
        sandbox.events.push(evt);
      }
    }

    console.log(`  Phase B done: ${activeTeams.length} teams (${Date.now() - phaseBStart}ms)`);
  } catch (err: any) {
    console.log(`  Phase B FAILED — ${err?.message?.slice(0, 80) ?? 'unknown error'} (${Date.now() - phaseBStart}ms)`);
  }
}

// ── Autopilot Tick: no LLM calls ────────────────────────────────────────

function runAutopilotTick(
  participants: Participant[],
  teams: Team[],
  phase: ScheduleBlock,
  time: string,
  tick: number,
  sandbox: SandboxState,
  recentLogs: LogEntry[],
): void {
  const autoStart = Date.now();

  const byRoom = new Map<RoomName, Participant[]>();
  for (const p of participants) {
    if (!byRoom.has(p.room)) byRoom.set(p.room, []);
    byRoom.get(p.room)!.push(p);
  }

  for (const [room, roomParticipants] of byRoom) {
    for (const p of roomParticipants) {
      const parsed = generateAutopilotAction(p, phase.phase, roomParticipants);
      const result = applyAction(p, parsed, participants, teams, tick, time);

      store.saveParticipant(p);
      store.appendActionLog(p.id, {
        tick, time, action_type: parsed.footer.ACTION,
        room: p.room, narrative: parsed.narrative,
        stats: { ...p.stats },
      });

      recentLogs.push({
        name: p.name,
        action: parsed.narrative.slice(0, 80),
        actionType: parsed.footer.ACTION,
        teamId: p.team_id,
      });

      if (result.newTeam) {
        store.saveTeam(result.newTeam);
        teams.push(result.newTeam);
      }
      for (const evt of result.events) {
        sandbox.events.push(evt);
      }
    }
  }

  console.log(`  Autopilot done (${Date.now() - autoStart}ms)`);
}
