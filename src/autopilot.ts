/**
 * autopilot.ts — Deterministic "fake it" engine for non-LLM ticks.
 * Pre-baked narrative templates + phase-aware heuristics make most ticks
 * instant while keeping the simulation alive and entertaining.
 */

import type { Participant, Team, RoomName, PhaseName, ParsedResponse } from './types.js';
import { ROOM_ADJACENCY } from './types.js';

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

type SimpleAction = 'code' | 'talk' | 'move' | 'chill' | 'pitch';

interface AutoAction {
  action: SimpleAction;
  room: RoomName;
  energy: number;
  momentum: number;
  morale: number;
}

function selectAction(p: Participant, phase: PhaseName, othersInRoom: Participant[]): AutoAction {
  const room = p.room;

  if (phase === 'KEYNOTE') {
    return { action: 'chill', room, energy: 2, momentum: 1, morale: 3 };
  }

  if (p.stats.energy < 15) {
    return { action: 'chill', room, energy: 10, momentum: -2, morale: 2 };
  }

  if (p.team_id) {
    if (phase === 'DEMOS') return { action: 'pitch', room, energy: -4, momentum: 3, morale: 4 };
    if (phase === 'CHECKINS') {
      return Math.random() < 0.6
        ? { action: 'talk', room, energy: -2, momentum: 2, morale: 3 }
        : { action: 'code', room, energy: -5, momentum: 4, morale: 2 };
    }
    return { action: 'code', room, energy: -6, momentum: 5, morale: 2 };
  }

  if (phase === 'NETWORKING' || phase === 'DINNER') {
    const r = Math.random();
    if (r < 0.5) return { action: 'talk', room, energy: -2, momentum: 1, morale: 4 };
    if (r < 0.75) {
      const nr = pick(ROOM_ADJACENCY[room]);
      return { action: 'move', room: nr, energy: -1, momentum: 0, morale: 2 };
    }
    return { action: 'chill', room, energy: 6, momentum: -1, morale: 2 };
  }

  if (phase === 'DEMOS') return { action: 'pitch', room, energy: -3, momentum: 2, morale: 3 };

  const r = Math.random();
  if (r < 0.45) return { action: 'code', room, energy: -5, momentum: 4, morale: 1 };
  if (r < 0.7) return { action: 'talk', room, energy: -2, momentum: 1, morale: 3 };
  if (r < 0.85) return { action: 'chill', room, energy: 6, momentum: -1, morale: 2 };
  const nr = pick(ROOM_ADJACENCY[room]);
  return { action: 'move', room: nr, energy: -1, momentum: 0, morale: 1 };
}

// ── Public API ──────────────────────────────────────────────────────────

export function generateAutopilotAction(
  p: Participant,
  phase: PhaseName,
  allInRoom: Participant[],
): ParsedResponse {
  const { action, room, energy, momentum, morale } = selectAction(p, phase, allInRoom);

  const templates = N[action] ?? [];
  const narrative = templates.length > 0
    ? interp(pick(templates), { name: p.name, other: pickOther(p, allInRoom), room })
    : `${p.name} ${action}s`;

  return {
    narrative,
    footer: { ACTION: action, ROOM: room, ENERGY: energy, MOMENTUM: momentum, MORALE: morale },
  };
}

export function isLLMTick(tick: number, phase: PhaseName, interval: number): boolean {
  if (phase === 'KEYNOTE') return false;
  if (phase === 'TRACKS') return true;
  if (phase === 'DEMOS') return true;
  if (phase === 'NETWORKING') return tick % 2 === 0;
  return tick % interval === 0;
}
