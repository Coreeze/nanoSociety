/**
 * engine.ts — The heartbeat loop for nanoSociety.
 * Coordinates all simulation phases: individual actions, team groupthink,
 * self-eval + identity mutation. All LLM calls within a phase fire in
 * parallel via Promise.all for maximum speed.
 */

import type {
  LLMProvider, Participant, Team, SandboxState,
  ScheduleBlock, SimEvent, PhaseName, RoomName,
} from './types.js';
import { SCHEDULE, HACKATHON_START_HOUR, TOTAL_HACKATHON_MINUTES } from './types.js';
import * as store from './store.js';
import {
  parseActionResponse, parseBatchActionResponse,
  parseSelfEvalResponse, parseMutationResponse,
  applyAction, applyTeamAction, applyStatChanges,
} from './actions.js';
import {
  buildBatchActionPrompt, buildTeamPrompt,
  buildSelfEvalPrompt, buildMutationPrompt,
} from './prompts.js';
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

// ── Engine ────────────────────────────────────────────────────────────────

export async function runSimulation(llm: LLMProvider): Promise<void> {
  const sandbox = store.loadSandbox();
  const tickInterval = parseInt(process.env.TICK_INTERVAL_MS ?? '2000', 10);
  const selfEvalInterval = parseInt(process.env.SELF_EVAL_INTERVAL ?? '12', 10);

  const recentLogs: LogEntry[] = [];
  const statSnapshots = new Map<string, { energy: number; momentum: number; morale: number }>();

  process.on('SIGINT', () => {
    console.log('\nSimulation interrupted. State saved.');
    process.exit(0);
  });

  // Broadcast initial state and wait for the client to press Start
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

      console.log(`\n── TICK ${tick}/${sandbox.totalTicks} ── ${time} ── ${phase.phase} ── T:${teams.length} S:${soloCount} P:${participants.length} ──`);

      if (phase.forceRoom) {
        console.log(`  Force room: ${phase.forceRoom}`);
        for (const p of participants) {
          p.room = phase.forceRoom;
          store.saveParticipant(p);
        }
      }

      // ── Phase A + B run in parallel ─────────────────────────────

      broadcastProgress(`Tick ${tick}/${sandbox.totalTicks} — processing actions...`);

      const phaseA = async () => {
        const solos = participants.filter(p => !p.team_id);
        if (solos.length === 0 || phase.phase === 'KEYNOTE') return;

        const byRoom = new Map<RoomName, Participant[]>();
        for (const p of solos) {
          if (!byRoom.has(p.room)) byRoom.set(p.room, []);
          byRoom.get(p.room)!.push(p);
        }

        console.log(`  Phase A: ${solos.length} solos across ${byRoom.size} rooms`);
        broadcastProgress(`Phase A: ${solos.length} solos across ${byRoom.size} rooms`);

        const phaseAStart = Date.now();

        const roomPromises = Array.from(byRoom.entries()).map(async ([room, roomSolos]) => {
          const roomStart = Date.now();
          const logsMap = new Map<string, unknown[]>();
          for (const p of roomSolos) {
            logsMap.set(p.id, store.readActionLog(p.id));
          }

          const maxTokens = Math.min(4096, 150 * roomSolos.length);

          try {
            const { system, user } = buildBatchActionPrompt(
              roomSolos, phase, time, participants, teams, logsMap,
            );
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
      };

      const phaseB = async () => {
        if (teams.length === 0 || phase.phase === 'KEYNOTE') return;

        console.log(`  Phase B: ${teams.length} teams`);
        broadcastProgress(`Phase B: ${teams.length} teams deciding...`);

        const phaseBStart = Date.now();

        const teamPromises = teams.map(async (team) => {
          const members = participants.filter(p => p.team_id === team.id);
          if (members.length === 0) return;

          const teamStart = Date.now();
          const logs = store.readActionLog(team.members[0]!);
          const { system, user } = buildTeamPrompt(team, members, phase, time, teams, logs);

          try {
            const raw = await llm.generate(system, user);
            const parsed = parseActionResponse(raw);
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

            console.log(`    ✓ ${team.name}: ${parsed.footer.ACTION} (${Date.now() - teamStart}ms)`);
          } catch (err: any) {
            console.log(`    ✗ ${team.name}: FAILED — ${err?.message?.slice(0, 80) ?? 'unknown error'} (${Date.now() - teamStart}ms)`);
          }
        });

        await Promise.all(teamPromises);
        console.log(`  Phase B done (${Date.now() - phaseBStart}ms)`);
      };

      await Promise.all([phaseA(), phaseB()]);

      participants = store.loadAllParticipants();
      teams = store.loadAllTeams();

      // ── Phase C: Self-eval + mutation (every N ticks) ────────────

      if (tick % selfEvalInterval === 0 && tick > 0) {
        console.log(`  Phase C: self-eval + mutation (${participants.length} participants)`);
        broadcastProgress(`Phase C: self-eval + mutation for ${participants.length} participants...`);
        participants = store.loadAllParticipants();

        const phaseCStart = Date.now();
        let mutationCount = 0;

        const evalPromises = participants.map(async (p) => {
          const logs = store.readActionLog(p.id);
          const before = statSnapshots.get(p.id) ?? { energy: 100, momentum: 50, morale: 80 };
          const { system: evalSys, user: evalUser } = buildSelfEvalPrompt(p, logs, before);

          try {
            const evalRaw = await llm.generate(evalSys, evalUser);
            const evalParsed = parseSelfEvalResponse(evalRaw);

            p.world_knowledge.push(...evalParsed.learnings);
            if (p.world_knowledge.length > 20) {
              p.world_knowledge = p.world_knowledge.slice(-20);
            }

            const { system: mutSys, user: mutUser } = buildMutationPrompt(p, evalParsed.narrative, evalParsed.learnings);
            const mutRaw = await llm.generate(mutSys, mutUser);
            const mutParsed = parseMutationResponse(mutRaw);

            if (mutParsed.newIdentity) {
              store.archiveIdentity(p.id, tick, p.identity_md);
              p.identity_md = mutParsed.newIdentity;
              mutationCount++;

              sandbox.events.push({
                tick, time, type: 'mutation',
                description: `${p.name}: ${mutParsed.changes}`,
              });

              recentLogs.push({
                name: p.name,
                action: `IDENTITY EVOLVED: ${mutParsed.changes.slice(0, 60)}`,
                actionType: 'mutation',
                teamId: p.team_id,
              });
            }

            store.saveParticipant(p);
          } catch (err) {
            // LLM failure — skip mutation
          }
        });

        await Promise.all(evalPromises);
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

      await sleep(tickInterval);
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
