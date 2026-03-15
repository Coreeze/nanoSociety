/**
 * autopilot.ts — Deterministic "fake it" engine for non-LLM ticks.
 * Pre-baked narrative templates + phase-aware heuristics make most ticks
 * instant while keeping the simulation alive and entertaining.
 */

import type { Participant, Team, RoomName, PhaseName, ParsedResponse } from './types.js';
import { ROOM_ADJACENCY, TRACKS } from './types.js';

// ── Helpers ──────────────────────────────────────────────────────────────

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function pickOther(p: Participant, allInRoom: Participant[]): string {
  const others = allInRoom.filter(o => o.id !== p.id);
  return others.length > 0 ? pick(others).name : 'someone nearby';
}

function interp(t: string, v: Record<string, string>): string {
  let s = t;
  for (const [k, val] of Object.entries(v)) s = s.replaceAll(`{${k}}`, val);
  return s;
}

function stableHash(input: string): number {
  let hash = 0;
  for (const ch of input) {
    hash = ((hash * 31) + ch.charCodeAt(0)) >>> 0;
  }
  return hash;
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

function projectIdeaFor(p: Participant): string {
  const cleanedGoal = p.goal
    .replace(/^build\s+/i, '')
    .replace(/^make\s+/i, '')
    .replace(/^create\s+/i, '')
    .trim();
  const idea = cleanedGoal || p.background.trim() || `${firstName(p.name)}'s hackathon build`;
  return idea.slice(0, 72);
}

function inferTrackForParticipant(p: Participant): number {
  const text = `${p.goal} ${p.identity_md} ${p.background} ${p.world_knowledge.join(' ')}`.toLowerCase();
  if (/(benchmark|evaluate|evaluation|metric|measure|scor)/.test(text)) return 2;
  if (/(self-improv|feedback|memory|learn|refin|evolv|adapt)/.test(text)) return 3;
  if (/(game|level|asset|npc|quest|player|dev)/.test(text)) return 4;
  if (/(openclaw|orchestrator|pipeline|module|build pipeline)/.test(text)) return 5;
  if (/(skill|workflow|tool|reasoning|planning|coordination)/.test(text)) return 1;
  return (stableHash(p.id) % TRACKS.length) + 1;
}

// ── Narrative Spice Bank ────────────────────────────────────────────────

const N = {
  code: [
    '{name} hammers out code, eyes locked on screen',
    '{name} debugs furiously, muttering about edge cases',
    '{name} pushes a clean commit and cracks knuckles',
    '{name} refactors a gnarly function into something beautiful',
    '{name} stares at a stack trace, then has an epiphany',
    '{name} writes tests — actually writes tests',
    '{name} pair-programs with the wall, wins the argument',
    '{name} ships a feature and does a tiny fist pump',
    '{name} deep in flow state, headphones on, world off',
    '{name} types so fast the keyboard sounds like rain',
    '{name} finally gets that regex to work',
    '{name} deletes more code than they write — progress',
    '{name} rage-quits vim, opens VSCode',
    '{name} discovers a beautiful API they wish they\'d found hours ago',
  ],
  talk: [
    '{name} chats with {other} about their project',
    '{name} argues passionately about framework choices with {other}',
    '{name} shares a wild idea with {other}',
    '{name} laughs at {other}\'s terrible variable names',
    '{name} and {other} bond over shared debugging pain',
    '{name} tells {other} about a breakthrough',
    '{name} asks {other} for help with a tricky bug',
    '{name} gives {other} unsolicited architecture advice',
    '{name} eavesdrops on {other}\'s conversation, joins in',
    '{name} and {other} realize they\'re solving the same problem',
    '{name} convinces {other} that Rust is the answer to everything',
    '{name} shows {other} a meme, both lose 5 minutes',
  ],
  move: [
    '{name} wanders to {room}',
    '{name} relocates to {room} for a change of scenery',
    '{name} drifts toward {room}',
    '{name} heads to {room}',
    '{name} migrates to {room} seeking better vibes',
  ],
  form_team: [
    '{name} recruits {other} and starts a team',
    '{name} teams up with {other} on the spot',
    '{name} and {other} decide to build together',
  ],
  join_team: [
    '{name} jumps onto a nearby team',
    '{name} joins forces with a team in the room',
    '{name} spots momentum and joins in',
  ],
  chill: [
    '{name} takes a breather, staring into space',
    '{name} stretches and grabs a snack',
    '{name} scrolls Twitter, "just for a sec"',
    '{name} zones out, recharging brain cells',
    '{name} leans back, eyes closed, thinking hard',
    '{name} grabs coffee — lost count of cups today',
    '{name} doomscrolls HackerNews for "research"',
    '{name} watches someone else\'s screen from across the room',
    '{name} contemplates the meaning of technical debt',
  ],
  pitch: [
    '{name} rehearses their pitch under their breath',
    '{name} demos their project to a small crowd',
    '{name} shows off their prototype with visible pride',
    '{name} pitches boldly — the crowd leans in',
    '{name} walks through their demo, only one thing crashes',
  ],
} as const;

// ── Drama Events ────────────────────────────────────────────────────────

export interface DramaEvent {
  description: string;
  energy: number;
  momentum: number;
  morale: number;
}

const DRAMA: DramaEvent[] = [
  { description: 'WiFi goes down for 5 minutes — collective groan echoes through the venue', energy: 0, momentum: -5, morale: -4 },
  { description: 'Pizza arrives! Everyone rushes to the kitchen', energy: 12, momentum: -2, morale: 8 },
  { description: 'Someone accidentally drops their laptop — gasp from the crowd', energy: 0, momentum: 0, morale: -3 },
  { description: 'A surprise mentor walks in and starts giving advice', energy: 0, momentum: 5, morale: 6 },
  { description: 'Power flickers — everyone frantically hits Ctrl+S', energy: -2, momentum: 0, morale: -5 },
  { description: 'Someone\'s demo crashes spectacularly in front of a judge', energy: 0, momentum: -3, morale: -4 },
  { description: 'Free Red Bulls appear on the bar — caffeine surge incoming', energy: 14, momentum: 3, morale: 5 },
  { description: 'Someone connects to the wrong projector — everyone sees their Spotify wrapped', energy: 0, momentum: -2, morale: 6 },
  { description: 'The AC breaks — it\'s getting tropical in here', energy: -6, momentum: -2, morale: -3 },
  { description: 'A dog wanders into the venue — productivity plummets, morale skyrockets', energy: 0, momentum: -5, morale: 12 },
  { description: 'Someone finds and fixes a production bug live — spontaneous applause', energy: 0, momentum: 6, morale: 7 },
  { description: 'Organizers announce a secret bonus prize — renewed energy everywhere', energy: 5, momentum: 8, morale: 10 },
  { description: 'Fire alarm goes off — false alarm, everyone returns grumbling', energy: -5, momentum: -4, morale: -6 },
  { description: 'Someone rage-quits their framework and rewrites everything in vanilla JS', energy: -3, momentum: -8, morale: 3 },
  { description: 'Two teams discover they\'re building the exact same thing', energy: 0, momentum: -3, morale: -5 },
  { description: 'The coffee machine breaks — this is now a crisis', energy: -8, momentum: -3, morale: -7 },
  { description: 'Someone deploys to production instead of staging — chaos ensues', energy: -2, momentum: -5, morale: -4 },
  { description: 'A team finishes early and starts helping other teams', energy: 3, momentum: 4, morale: 8 },
  { description: 'Thunder and lightning outside — the hackers feel like mad scientists', energy: 2, momentum: 4, morale: 5 },
  { description: 'Someone starts playing lo-fi hip hop on the speakers — vibe shift', energy: 3, momentum: 5, morale: 6 },
];

export function rollDrama(): DramaEvent | null {
  return Math.random() < 0.12 ? pick(DRAMA) : null;
}

// ── Deterministic Action Selection ──────────────────────────────────────

type SimpleAction = 'code' | 'talk' | 'move' | 'chill' | 'pitch' | 'form_team' | 'join_team';

interface AutoAction {
  action: SimpleAction;
  room: RoomName;
  energy: number;
  momentum: number;
  morale: number;
  target?: string;
  teamName?: string;
  project?: string;
  track?: string;
}

function moveToAdjacentRoom(
  room: RoomName,
  energy = -2,
  momentum = 1,
  morale = 2,
): AutoAction {
  return {
    action: 'move',
    room: pick(ROOM_ADJACENCY[room]),
    energy,
    momentum,
    morale,
  };
}

function joinNearbyTeam(room: RoomName, target: string): AutoAction {
  return {
    action: 'join_team',
    room,
    energy: -2,
    momentum: 3,
    morale: 4,
    target,
  };
}

function formNearbyTeam(p: Participant, room: RoomName, partner: Participant): AutoAction {
  const p1 = firstName(p.name);
  const p2 = firstName(partner.name);
  return {
    action: 'form_team',
    room,
    energy: -2,
    momentum: 4,
    morale: 5,
    target: partner.name,
    teamName: `${p1} ${p2} Labs`,
    project: `${projectIdeaFor(p)} with ${p2}`,
    track: String(inferTrackForParticipant(p)),
  };
}

function selectAction(p: Participant, phase: PhaseName, othersInRoom: Participant[]): AutoAction {
  const room = p.room;
  const alone = othersInRoom.length === 0;
  const crowded = othersInRoom.length >= 4;
  const nearbySolos = othersInRoom.filter(o => !o.team_id);
  const nearbyTeams = Array.from(new Map(
    othersInRoom
      .filter(o => o.team_id)
      .map(o => [o.team_id!, o.team_id!]),
  ).values());

  if (phase === 'KEYNOTE') {
    return { action: 'chill', room, energy: 2, momentum: 1, morale: 3 };
  }

  if (p.stats.energy < 15) {
    return { action: 'chill', room, energy: 10, momentum: -2, morale: 2 };
  }

  if (p.team_id) {
    if (phase === 'DEMOS') return { action: 'pitch', room, energy: -4, momentum: 3, morale: 4 };
    if (phase === 'CHECKINS') {
      const r = Math.random();
      if (r < 0.3) return moveToAdjacentRoom(room, -2, 1, 2);
      if (r < 0.65) return { action: 'talk', room, energy: -2, momentum: 2, morale: 3 };
      return { action: 'code', room, energy: -5, momentum: 4, morale: 2 };
    }

    const r = Math.random();
    if (crowded && r < 0.3) return moveToAdjacentRoom(room, -2, 1, 1);
    if (r < 0.18) return moveToAdjacentRoom(room, -2, 1, 1);
    if (r < 0.72) return { action: 'code', room, energy: -6, momentum: 5, morale: 2 };
    if (r < 0.88) return { action: 'talk', room, energy: -2, momentum: 2, morale: 3 };
    return { action: 'chill', room, energy: 6, momentum: -1, morale: 2 };
  }

  if (phase === 'TRACKS') {
    const r = Math.random();
    if (nearbyTeams.length > 0 && r < 0.5) return joinNearbyTeam(room, pick(nearbyTeams));
    if (nearbySolos.length > 0 && r < 0.85) return formNearbyTeam(p, room, pick(nearbySolos));
    if (alone) return moveToAdjacentRoom(room, -1, 1, 2);
    return { action: 'talk', room, energy: -2, momentum: 2, morale: 3 };
  }

  if (phase === 'NETWORKING' || phase === 'DINNER') {
    const r = Math.random();
    if (nearbyTeams.length > 0 && r < 0.28) return joinNearbyTeam(room, pick(nearbyTeams));
    if (nearbySolos.length > 0 && r < 0.58) return formNearbyTeam(p, room, pick(nearbySolos));
    if (alone || r < 0.45) return moveToAdjacentRoom(room, -1, 1, 3);
    if (r < 0.8) return { action: 'talk', room, energy: -2, momentum: 1, morale: 4 };
    return { action: 'chill', room, energy: 6, momentum: -1, morale: 2 };
  }

  if (phase === 'DEMOS') return { action: 'pitch', room, energy: -3, momentum: 2, morale: 3 };

  const r = Math.random();
  if (nearbyTeams.length > 0 && r < 0.14) return joinNearbyTeam(room, pick(nearbyTeams));
  if (nearbySolos.length > 0 && r < 0.3) return formNearbyTeam(p, room, pick(nearbySolos));
  if (alone || (crowded && r < 0.35)) return moveToAdjacentRoom(room, -2, 1, 2);
  if (r < 0.36) return { action: 'code', room, energy: -5, momentum: 4, morale: 1 };
  if (r < 0.58) return { action: 'talk', room, energy: -2, momentum: 1, morale: 3 };
  if (r < 0.72) return { action: 'chill', room, energy: 6, momentum: -1, morale: 2 };
  return moveToAdjacentRoom(room, -2, 1, 2);
}

// ── Public API ──────────────────────────────────────────────────────────

export function generateAutopilotAction(
  p: Participant,
  phase: PhaseName,
  allInRoom: Participant[],
): ParsedResponse {
  const { action, room, energy, momentum, morale, target, teamName, project, track } = selectAction(p, phase, allInRoom);

  const templates = N[action] ?? [];
  const narrative = templates.length > 0
    ? interp(pick(templates), { name: p.name, other: pickOther(p, allInRoom), room })
    : `${p.name} ${action}s`;

  return {
    narrative,
    footer: {
      ACTION: action,
      ROOM: room,
      ENERGY: energy,
      MOMENTUM: momentum,
      MORALE: morale,
      TARGET: target,
      TEAM_NAME: teamName,
      PROJECT: project,
      TRACK: track,
    },
  };
}

export function isLLMTick(tick: number, phase: PhaseName, interval: number): boolean {
  if (phase === 'KEYNOTE') return false;
  if (phase === 'TRACKS') return true;
  if (phase === 'DEMOS') return true;
  if (phase === 'NETWORKING') return tick % 2 === 0;
  return tick % interval === 0;
}
