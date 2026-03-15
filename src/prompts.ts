/**
 * prompts.ts — All prompt templates for nanoSociety.
 * Generates system and user prompts for individual actions, team groupthink,
 * self-evaluation, identity mutation, and the final history generation.
 * All prompts instruct the LLM to use the text + --- + footer format.
 */

import type { Participant, Team, RoomName, ScheduleBlock } from './types.js';
import { ROOM_ADJACENCY, ROOM_VIBES, TRACKS } from './types.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function formatStats(p: Participant): string {
  return `Energy: ${p.stats.energy}/100, Momentum: ${p.stats.momentum}/100, Morale: ${p.stats.morale}/100`;
}

function adjacentRooms(room: RoomName): string {
  return ROOM_ADJACENCY[room].join(', ');
}

function roomVibe(room: RoomName): string {
  return ROOM_VIBES[room];
}

function formatKnowledge(p: Participant, limit = 5): string {
  if (p.world_knowledge.length === 0) return 'None yet.';
  return p.world_knowledge.slice(-limit).join('\n- ');
}

function formatRecentLogs(logs: unknown[], count: number): string {
  const recent = logs.slice(-count);
  if (recent.length === 0) return 'No actions yet.';
  return recent.map((l: any) => `[${l.time}] ${l.action_type}: ${l.narrative?.slice(0, 80) ?? ''}`).join('\n');
}

function participantList(participants: Participant[], excludeId?: string): string {
  return participants
    .filter(p => p.id !== excludeId)
    .map(p => `${p.name} (${p.room}${p.team_id ? `, team: ${p.team_id}` : ', solo'})`)
    .join(', ');
}

function teamList(teams: Team[]): string {
  if (teams.length === 0) return 'No teams formed yet.';
  return teams.map(t =>
    `${t.name} [Track ${t.track}] — "${t.project_name}" — members: ${t.members.length}`
  ).join('\n');
}

const FOOTER_INSTRUCTIONS = `
End your response with a metadata footer separated by ---
The footer must have these KEY: value pairs, one per line:
ACTION: code | talk | move | form_team | join_team | leave_team | pitch | chill
ROOM: your current or new room (must be your current room or an adjacent one)
ENERGY: change as integer (e.g., -8 or 5)
MOMENTUM: change as integer
MORALE: change as integer

Prefer movement more often than before. If moving to an adjacent room to find teammates, feedback, food, or better vibes makes sense, choose move instead of staying put.
If you are solo and there are promising people or teams nearby, strongly prefer form_team or join_team instead of staying solo for too long.

For team actions, also include:
TARGET: person-id or team-id
TEAM_NAME: name (only for form_team)
PROJECT: project description (only for form_team)
TRACK: track number 1-5 (only for form_team)
`.trim();

// ── Individual Action Prompt ──────────────────────────────────────────────

export function buildActionPrompt(
  participant: Participant,
  schedule: ScheduleBlock,
  time: string,
  allParticipants: Participant[],
  teams: Team[],
  recentLogs: unknown[],
): { system: string; user: string } {
  const sameRoom = allParticipants.filter(p => p.id !== participant.id && p.room === participant.room);

  const system = `You are ${participant.name}. Identity: ${participant.identity_md}
Goal: ${participant.goal}
Phase: ${schedule.phase} — ${schedule.prompt} | Time: ${time}

Actions: code, talk, move, form_team, join_team, leave_team, pitch, chill
Roam actively. Do not stay in one room unless there is a good reason.
If you are solo during NETWORKING, TRACKS, or early BUILDING, actively seek teammates and prefer forming or joining a team.

Write MAX 5 WORDS as your action, then --- footer.
${FOOTER_INSTRUCTIONS}`;

  const user = `Room: ${participant.room} | Adjacent: ${adjacentRooms(participant.room)}
Stats: ${formatStats(participant)} | Team: ${participant.team_id ?? 'solo'}
Here: ${sameRoom.length > 0 ? sameRoom.map(p => p.name).join(', ') : 'nobody'}
Teams: ${teamList(teams)}

Max 5 words, then --- footer.`;

  return { system, user };
}

// ── Batched Action Prompt (one call per room) ────────────────────────────

export function buildBatchActionPrompt(
  solosInRoom: Participant[],
  schedule: ScheduleBlock,
  time: string,
  allParticipants: Participant[],
  teams: Team[],
  logsMap: Map<string, unknown[]>,
): { system: string; user: string } {
  const room = solosInRoom[0]!.room;

  const system = `Narrator for ${solosInRoom.length} solo participants.
Phase: ${schedule.phase} — ${schedule.prompt} | Time: ${time}
Room: ${room} | Adjacent: ${adjacentRooms(room)}

Actions: code, talk, move, form_team, join_team, leave_team, pitch, chill
Bias toward more roaming. Participants should frequently move to adjacent rooms to meet people, scout teams, grab food, or reset.
Strongly encourage solo participants to form teams or join nearby teams once they have plausible collaborators.

For EACH participant write:

[EXACT_FULL_NAME]
Max 5 words
---
ACTION: one action
ROOM: current or adjacent room
ENERGY: integer change
MOMENTUM: integer change
MORALE: integer change
TARGET: person-id or team-id (if applicable)
TEAM_NAME: name (only for form_team)
PROJECT: short description (only for form_team)
TRACK: 1-5 (only for form_team)

Do NOT skip anyone.`;

  const participantBlocks = solosInRoom.map(p => {
    const othersInRoom = allParticipants.filter(o => o.id !== p.id && o.room === room);
    return `[${p.name}]
Goal: ${p.goal} | Stats: ${formatStats(p)}
Here: ${othersInRoom.length > 0 ? othersInRoom.slice(0, 5).map(o => o.name).join(', ') : 'nobody'}`;
  }).join('\n\n');

  const user = `${participantBlocks}

Teams: ${teamList(teams)}

Max 5 words per person, then --- footer.`;

  return { system, user };
}

// ── Team Groupthink Prompt ────────────────────────────────────────────────

export function buildTeamPrompt(
  team: Team,
  members: Participant[],
  schedule: ScheduleBlock,
  time: string,
  allTeams: Team[],
  recentLogs: unknown[],
): { system: string; user: string } {
  const system = `You are team "${team.name}". Project: "${team.project_name}" | Track: ${team.track}
Phase: ${schedule.phase} — ${schedule.prompt} | Time: ${time}

Actions: code, talk, pitch, chill, move
Move rooms sometimes instead of camping in one spot all day.

Write MAX 5 WORDS as the team decision, then --- footer.
${FOOTER_INSTRUCTIONS}`;

  const memberSummary = members.map(m =>
    `${m.name}: E:${m.stats.energy} M:${m.stats.momentum} Mo:${m.stats.morale}`
  ).join(', ');

  const user = `Members: ${memberSummary}

Max 5 words, then --- footer.`;

  return { system, user };
}

// ── Batched Team Prompt (one call for all teams) ─────────────────────────

export function buildBatchTeamPrompt(
  teams: Team[],
  membersMap: Map<string, Participant[]>,
  schedule: ScheduleBlock,
  time: string,
  allTeams: Team[],
  logsMap: Map<string, unknown[]>,
): { system: string; user: string } {
  const system = `Narrator for ${teams.length} teams.
Phase: ${schedule.phase} — ${schedule.prompt} | Time: ${time}

Actions: code, talk, pitch, chill, move
Bias toward more room changes than before. Teams should occasionally relocate to adjacent rooms for feedback, food, focus, or better energy.

For EACH team write:

[EXACT_TEAM_NAME]
Max 5 words
---
ACTION: one action
ROOM: current or new room
ENERGY: integer change
MOMENTUM: integer change
MORALE: integer change
PROJECT: new description (only if pivoting)

Do NOT skip any.`;

  const teamBlocks = teams.map(team => {
    const members = membersMap.get(team.id) ?? [];
    const memberSummary = members.map(m =>
      `${m.name}: E:${m.stats.energy} M:${m.stats.momentum}`
    ).join(', ');

    return `[${team.name}]
Project: "${team.project_name}" | Track: ${team.track}
Members: ${memberSummary}`;
  }).join('\n\n');

  const user = `${teamBlocks}

Max 5 words per team, then --- footer.`;

  return { system, user };
}

// ── Self-Eval + Mutation (merged) ─────────────────────────────────────────

export function buildSelfEvalAndMutationPrompt(
  participant: Participant,
  recentLogs: unknown[],
  statsBefore: { energy: number; momentum: number; morale: number },
): { system: string; user: string } {
  const system = `You are ${participant.name}. Self-eval and identity tweak.
Identity: ${participant.identity_md}
Goal: ${participant.goal}

Write MAX 5 WORDS reflecting on progress, then --- footer:
PROGRESS: advancing | stagnant | regressing
LEARNINGS: learning1 | learning2 (pipe-separated)
CHANGES: one short phrase
NEW_IDENTITY: updated identity (2 sentences max, first person)`;

  const user = `Before: E:${statsBefore.energy} M:${statsBefore.momentum} Mo:${statsBefore.morale}
Now: E:${participant.stats.energy} M:${participant.stats.momentum} Mo:${participant.stats.morale}
Team: ${participant.team_id ?? 'solo'}
Recent: ${formatRecentLogs(recentLogs, 3)}

Max 5 words, then --- footer.`;

  return { system, user };
}

// ── Batched Self-Eval + Mutation (one call per batch) ─────────────────────

export function buildBatchSelfEvalPrompt(
  participants: Participant[],
  logsMap: Map<string, unknown[]>,
  statsBeforeMap: Map<string, { energy: number; momentum: number; morale: number }>,
): { system: string; user: string } {
  const system = `Self-eval narrator for ${participants.length} participants.

For EACH participant write:

[EXACT_FULL_NAME]
Max 5 words reflecting on progress
---
PROGRESS: advancing | stagnant | regressing
LEARNINGS: learning1 | learning2 (pipe-separated)
CHANGES: one short phrase
NEW_IDENTITY: updated identity (2 sentences max, first person)

Do NOT skip anyone.`;

  const blocks = participants.map(p => {
    const before = statsBeforeMap.get(p.id) ?? { energy: 100, momentum: 50, morale: 80 };
    return `[${p.name}]
Identity: ${p.identity_md}
Goal: ${p.goal}
Before: E:${before.energy} M:${before.momentum} Mo:${before.morale}
Now: E:${p.stats.energy} M:${p.stats.momentum} Mo:${p.stats.morale}
Team: ${p.team_id ?? 'solo'}
Recent: ${formatRecentLogs(logsMap.get(p.id) ?? [], 3)}`;
  }).join('\n\n');

  const user = `${blocks}\n\nMax 5 words per person, then --- footer.`;

  return { system, user };
}

// ── Batch Seed Identity Prompt ────────────────────────────────────────────

export function buildBatchSeedPrompt(
  participants: { name: string; background: string }[],
): { system: string; user: string } {
  const system = `Generate identities for ${participants.length} hackathon participants.
For each person: 2 sentences max, first person — who you are and what you want.

For EACH participant write:

[EXACT_FULL_NAME]
---
IDENTITY: 2 sentences, first person
GOAL: one short sentence

Do NOT skip anyone.`;

  const blocks = participants.map(p =>
    `[${p.name}]\nBackground: ${p.background || 'No background provided — invent a plausible profile.'}`
  ).join('\n\n');

  const user = `PARTICIPANTS:\n\n${blocks}\n\nWrite one [NAME] block per participant above.`;

  return { system, user };
}

// ── History Generation Prompt ─────────────────────────────────────────────

export function buildHistoryPrompt(
  timeline: string,
  teamSummaries: string,
  dramaHighlights: string,
  winners: string,
): { system: string; user: string } {
  const system = `Write a 3-5 sentence summary of this hackathon. Name people and teams. Keep it tight.`;

  const user = `TIMELINE OF MAJOR EVENTS:
${timeline}

TEAMS AND PROJECTS:
${teamSummaries}

DRAMA HIGHLIGHTS:
${dramaHighlights}

WINNERS:
${winners}

Write the history.`;

  return { system, user };
}
