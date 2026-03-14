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

function formatKnowledge(p: Participant): string {
  if (p.world_knowledge.length === 0) return 'None yet.';
  return p.world_knowledge.slice(-10).join('\n- ');
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

  const system = `You are ${participant.name} at a hackathon at the AGI House.
Your identity: ${participant.identity_md}
Your goal: ${participant.goal}

You are a real person with agency. Act in character. Be specific. Be human.

SCHEDULE PHASE: ${schedule.phase} — ${schedule.prompt}
Current time: ${time}

You can do ONE action per turn:
1. code — build your project (+momentum, -energy)
2. talk — chat with someone in your room
3. move — go to an adjacent room
4. form_team — create a team with someone here (pick a track 1-5)
5. join_team — join a team that has members in your room
6. leave_team — leave your current team
7. pitch — practice or deliver your demo
8. chill — rest, eat, recharge (+energy, -momentum)

${FOOTER_INSTRUCTIONS}`;

  const user = `CURRENT STATE:
Room: ${participant.room} (${roomVibe(participant.room)})
Adjacent rooms: ${adjacentRooms(participant.room)}
Stats: ${formatStats(participant)}
Team: ${participant.team_id ?? 'solo'}

PEOPLE IN YOUR ROOM:
${sameRoom.length > 0 ? sameRoom.map(p => `- ${p.name}${p.team_id ? ` (${p.team_id})` : ' (solo)'}`).join('\n') : 'Nobody else here.'}

EXISTING TEAMS:
${teamList(teams)}

THINGS YOU KNOW:
- ${formatKnowledge(participant)}

YOUR RECENT ACTIONS:
${formatRecentLogs(recentLogs, 3)}

TRACKS:
${TRACKS.join('\n')}

What do you do? Write 1-3 sentences in first person, then the --- footer.`;

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
  const system = `You are the collective mind of "${team.name}", a hackathon team at the AGI House.
Team identity: ${team.identity_md}
Project: "${team.project_name}" — ${team.project_desc}
Track: ${team.track}

SCHEDULE PHASE: ${schedule.phase} — ${schedule.prompt}
Current time: ${time}

Make a GROUP DECISION. You can:
1. code — team builds together (+momentum, -energy for all)
2. talk — team discusses direction
3. pitch — practice your demo together
4. chill — team takes a break
5. move — relocate the team to a different room (pick from adjacent rooms of any member)

Write 1-3 sentences as the team voice, then --- footer.

${FOOTER_INSTRUCTIONS}`;

  const memberSummary = members.map(m =>
    `${m.name}: E:${m.stats.energy} M:${m.stats.momentum} Mo:${m.stats.morale} @ ${m.room}`
  ).join('\n');

  const user = `TEAM STATE:
Members: ${members.length}
${memberSummary}

Project: "${team.project_name}" — ${team.project_desc}
Pivots so far: ${team.pivots.length}
Track: ${TRACKS[team.track - 1]}

OTHER TEAMS:
${allTeams.filter(t => t.id !== team.id).map(t => `${t.name} — "${t.project_name}" (${t.members.length} members)`).join('\n') || 'None'}

RECENT TEAM ACTIONS:
${formatRecentLogs(recentLogs, 3)}

What does the team decide? Write 1-3 sentences, then --- footer.`;

  return { system, user };
}

// ── Self-Eval Prompt ──────────────────────────────────────────────────────

export function buildSelfEvalPrompt(
  participant: Participant,
  recentLogs: unknown[],
  statsBefore: { energy: number; momentum: number; morale: number },
): { system: string; user: string } {
  const system = `You are ${participant.name} doing a self-evaluation at the hackathon.
Your identity: ${participant.identity_md}
Your goal: ${participant.goal}

Reflect on the causal chain: your identity made you choose certain actions.
Did those actions move you toward winning? What did you learn?

End with --- footer:
PROGRESS: advancing | stagnant | regressing
LEARNINGS: learning1 | learning2 | learning3 (pipe-separated)`;

  const user = `YOUR STATS BEFORE: E:${statsBefore.energy} M:${statsBefore.momentum} Mo:${statsBefore.morale}
YOUR STATS NOW: E:${participant.stats.energy} M:${participant.stats.momentum} Mo:${participant.stats.morale}
Team: ${participant.team_id ?? 'solo'}

ACTIONS SINCE LAST EVAL:
${formatRecentLogs(recentLogs, 12)}

THINGS YOU KNOW:
- ${formatKnowledge(participant)}

Reflect in 2-4 sentences. Then --- footer.`;

  return { system, user };
}

// ── Mutation Prompt ───────────────────────────────────────────────────────

export function buildMutationPrompt(
  participant: Participant,
  selfEvalNarrative: string,
  learnings: string[],
): { system: string; user: string } {
  const system = `You are ${participant.name} adjusting your hackathon strategy.
Based on your self-evaluation, propose SMALL, INCREMENTAL tweaks to your identity.
No wholesale rewrites. Small tactical shifts only.

End with --- footer:
CHANGES: one-sentence summary of what changed
NEW_IDENTITY: your full updated identity (2-4 sentences)`;

  const user = `CURRENT IDENTITY:
${participant.identity_md}

SELF-EVALUATION:
${selfEvalNarrative}

NEW LEARNINGS:
${learnings.map(l => `- ${l}`).join('\n')}

Propose small tweaks. Write 1-2 sentences explaining why, then --- footer.`;

  return { system, user };
}

// ── Seed Identity Prompt ──────────────────────────────────────────────────

export function buildSeedIdentityPrompt(name: string, background: string): { system: string; user: string } {
  const system = `Generate a brief hackathon participant identity for this person.
Write 2-3 sentences in first person describing who they are, how they approach hackathons,
what they value, and their competitive style. Be specific and human.

End with --- footer:
IDENTITY: the full identity text (2-3 sentences, first person)
GOAL: a one-sentence hackathon goal`;

  const user = `Name: ${name}
Background: ${background || 'No background provided — invent a plausible hackathon participant profile.'}`;

  return { system, user };
}

// ── History Generation Prompt ─────────────────────────────────────────────

export function buildHistoryPrompt(
  timeline: string,
  teamSummaries: string,
  dramaHighlights: string,
  winners: string,
): { system: string; user: string } {
  const system = `You are a journalist writing a narrative history of a hackathon at the AGI House.
Write 3-4 vivid paragraphs capturing the energy, drama, pivots, and triumphs of the day.
Name specific people and teams. Make it feel alive.`;

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
