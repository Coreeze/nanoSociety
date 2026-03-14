/**
 * engine.ts — The heartbeat loop for nanoSociety.
 * Coordinates all simulation phases: individual actions, team groupthink,
 * self-eval + identity mutation. All LLM calls within a phase fire in
 * parallel via Promise.all for maximum speed.
 */

import type {
  LLMProvider, Participant, Team, SandboxState,
  ScheduleBlock, SimEvent, PhaseName,
} from './types.js';
import { SCHEDULE, HACKATHON_START_HOUR, TOTAL_HACKATHON_MINUTES } from './types.js';
import * as store from './store.js';
import {
  parseActionResponse, parseSelfEvalResponse, parseMutationResponse,
  applyAction, applyTeamAction, applyStatChanges,
} from './actions.js';
import {
  buildActionPrompt, buildTeamPrompt,
  buildSelfEvalPrompt, buildMutationPrompt,
} from './prompts.js';
import {
  enterFullscreen, exitFullscreen, renderFrame, buildFrame,
} from './renderer.js';
import type { LogEntry } from './renderer.js';

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

  enterFullscreen();

  process.on('SIGINT', () => {
    exitFullscreen();
    console.log('\nSimulation interrupted. State saved.');
    process.exit(0);
  });

  try {
    for (let tick = sandbox.tick + 1; tick <= sandbox.totalTicks; tick++) {
      const minutes = tickToMinutes(tick, sandbox.minutesPerTick);
      const time = minutesToClock(minutes);
      const phase = getPhase(minutes);

      let participants = store.loadAllParticipants();
      let teams = store.loadAllTeams();

      // Apply schedule constraints (force room moves)
      if (phase.forceRoom) {
        for (const p of participants) {
          p.room = phase.forceRoom;
          store.saveParticipant(p);
        }
      }

      // ── Phase A: Solo participant actions (parallel) ─────────────

      const solos = participants.filter(p => !p.team_id);
      if (solos.length > 0 && phase.phase !== 'KEYNOTE') {
        const soloPromises = solos.map(async (p) => {
          const logs = store.readActionLog(p.id);
          const { system, user } = buildActionPrompt(p, phase, time, participants, teams, logs);

          try {
            const raw = await llm.generate(system, user);
            const parsed = parseActionResponse(raw);
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
          } catch (err) {
            // LLM failure — skip this participant for this tick
          }
        });

        await Promise.all(soloPromises);
      }

      // Reload in case teams changed
      participants = store.loadAllParticipants();
      teams = store.loadAllTeams();

      // ── Phase B: Team groupthink (parallel) ──────────────────────

      if (teams.length > 0 && phase.phase !== 'KEYNOTE') {
        const teamPromises = teams.map(async (team) => {
          const members = participants.filter(p => p.team_id === team.id);
          if (members.length === 0) return;

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
          } catch (err) {
            // LLM failure — skip this team for this tick
          }
        });

        await Promise.all(teamPromises);
      }

      // ── Phase C: Self-eval + mutation (every N ticks) ────────────

      if (tick % selfEvalInterval === 0 && tick > 0) {
        participants = store.loadAllParticipants();

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

        // Snapshot stats for next eval comparison
        for (const p of store.loadAllParticipants()) {
          statSnapshots.set(p.id, { ...p.stats });
        }
      }

      // ── Render + Save ───────────────────────────────────────────

      participants = store.loadAllParticipants();
      teams = store.loadAllTeams();

      sandbox.tick = tick;
      store.saveSandbox(sandbox);

      const frame = buildFrame(
        tick, sandbox.totalTicks, time, phase.phase,
        participants, teams, recentLogs.slice(-10),
      );
      renderFrame(frame);

      // Trim log buffer
      if (recentLogs.length > 50) recentLogs.splice(0, recentLogs.length - 30);

      await sleep(tickInterval);
    }
  } finally {
    exitFullscreen();
  }

  console.log('\n════════════════════════════════════════════════════════');
  console.log('  SIMULATION COMPLETE');
  console.log(`  ${sandbox.totalTicks} ticks  │  ${sandbox.events.length} events logged`);
  console.log('  Run: npm run analyze');
  console.log('════════════════════════════════════════════════════════\n');
}
