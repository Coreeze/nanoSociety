/**
 * types.ts — All TypeScript interfaces for nanoSociety.
 * Central type definitions for participants, teams, rooms, sandbox state,
 * LLM provider, and response formats.
 */

// ── Rooms ──────────────────────────────────────────────────────────────────

export const ROOM_NAMES = [
  'FRONT_GARDEN',
  'HALLWAY_1',
  'MAIN_ROOM',
  'HALLWAY_2',
  'KITCHEN',
  'BACK_GARDEN',
  'BAR',
  'BATHROOM',
  'OFFICE',
  'STORAGE',
  'STAIRS',
  'SECOND_FLOOR',
] as const;

export type RoomName = (typeof ROOM_NAMES)[number];

export const ROOM_ADJACENCY: Record<RoomName, RoomName[]> = {
  FRONT_GARDEN: ['HALLWAY_1'],
  HALLWAY_1: ['FRONT_GARDEN', 'MAIN_ROOM', 'HALLWAY_2'],
  MAIN_ROOM: ['HALLWAY_1'],
  HALLWAY_2: ['HALLWAY_1', 'KITCHEN', 'BAR', 'BATHROOM', 'OFFICE', 'STORAGE', 'STAIRS'],
  KITCHEN: ['HALLWAY_2', 'BACK_GARDEN'],
  BACK_GARDEN: ['KITCHEN'],
  BAR: ['HALLWAY_2'],
  BATHROOM: ['HALLWAY_2'],
  OFFICE: ['HALLWAY_2'],
  STORAGE: ['HALLWAY_2'],
  STAIRS: ['HALLWAY_2', 'SECOND_FLOOR'],
  SECOND_FLOOR: ['STAIRS'],
};

export const ROOM_VIBES: Record<RoomName, string> = {
  FRONT_GARDEN: 'Fresh air, quiet thinking, arrival zone',
  HALLWAY_1: 'Passing through, bump into people',
  MAIN_ROOM: 'The hacking floor — tables, laptops, high energy',
  HALLWAY_2: 'Passing through, connects most rooms',
  KITCHEN: 'Snacks, coffee, casual chats',
  BACK_GARDEN: 'Secluded, deep focus or secret conversations',
  BAR: 'Drinks, loud, social energy',
  BATHROOM: 'Brief escape from everything',
  OFFICE: 'Quiet, heads-down coding space',
  STORAGE: 'Hiding from everyone',
  STAIRS: 'Transitional, going up or down',
  SECOND_FLOOR: 'Overflow space, quieter upstairs',
};

// ── Stats ──────────────────────────────────────────────────────────────────

export interface Stats {
  energy: number;    // 0-100, decreases with work, increases with rest
  momentum: number;  // 0-100, increases with focused coding, decreases with pivots
  morale: number;    // 0-100, good team = high, drama = low
}

// ── Participant ────────────────────────────────────────────────────────────

export interface ParticipantInput {
  name: string;
  background?: string;
}

export interface Participant {
  id: string;
  name: string;
  background: string;
  identity_md: string;
  goal: string;
  stats: Stats;
  room: RoomName;
  team_id: string | null;
  world_knowledge: string[];
  history_summary: string;
}

// ── Team ───────────────────────────────────────────────────────────────────

export interface TeamPivot {
  tick: number;
  time: string;
  from: string;
  to: string;
}

export interface Team {
  id: string;
  name: string;
  track: number;
  project_name: string;
  project_desc: string;
  identity_md: string;
  members: string[];
  founded_tick: number;
  pivots: TeamPivot[];
}

// ── Schedule ───────────────────────────────────────────────────────────────

export type PhaseName =
  | 'NETWORKING'
  | 'KEYNOTE'
  | 'TRACKS'
  | 'BUILDING'
  | 'CHECKINS'
  | 'DINNER'
  | 'DEMOS';

export interface ScheduleBlock {
  phase: PhaseName;
  startMinute: number; // minutes from 10:00 AM
  endMinute: number;
  prompt: string;
  forceRoom?: RoomName;
}

export const HACKATHON_START_HOUR = 10; // 10:00 AM

export const SCHEDULE: ScheduleBlock[] = [
  { phase: 'NETWORKING', startMinute: 0, endMinute: 60, prompt: 'Doors just opened. Mingle. Scope out the crowd. No teams yet.' },
  { phase: 'KEYNOTE', startMinute: 60, endMinute: 120, prompt: 'Opening keynote in MAIN_ROOM. Listen. Get inspired.', forceRoom: 'MAIN_ROOM' },
  { phase: 'TRACKS', startMinute: 120, endMinute: 135, prompt: 'Tracks announced. Pick your track. Start forming teams.' },
  { phase: 'BUILDING', startMinute: 135, endMinute: 420, prompt: 'Heads down. Build. Ship. Lunch is around.' },
  { phase: 'CHECKINS', startMinute: 420, endMinute: 480, prompt: 'Mid-session check-ins. Show progress. Get feedback.' },
  { phase: 'DINNER', startMinute: 480, endMinute: 600, prompt: 'Dinner break. Eat. Recharge. Polish. Last push.' },
  { phase: 'DEMOS', startMinute: 600, endMinute: 690, prompt: 'Showtime. Pitch. Watch others. Judges are scoring.', forceRoom: 'MAIN_ROOM' },
];

export const TOTAL_HACKATHON_MINUTES = 690; // 10:00 AM to 9:30 PM

export const TRACKS = [
  '1. New Agent Skills — Design novel, reusable agent skills for planning, tool use, reasoning, coordination, or domain-specific workflows.',
  '2. Skill Benchmarking & Evaluation — Build frameworks to measure agent skill quality with real deployment metrics.',
  '3. Self-Improving Skills — Develop systems where agent skills refine themselves through feedback loops, memory, automated evaluation.',
  '4. Skill Orchestration for Game Dev — Build composable skill pipelines for game development workflows.',
  '5. Skills for OpenClaw — Design orchestrator skills that coordinate multiple modules into coherent build pipelines.',
];

// ── Sandbox State ──────────────────────────────────────────────────────────

export interface SimEvent {
  tick: number;
  time: string;
  type: string;
  description: string;
}

export interface SandboxState {
  tick: number;
  minutesPerTick: number;
  totalTicks: number;
  events: SimEvent[];
}

// ── Judges ─────────────────────────────────────────────────────────────────

export interface Judge {
  name: string;
  background: string;
}

// ── LLM ────────────────────────────────────────────────────────────────────

export interface LLMProvider {
  generate(system: string, user: string): Promise<string>;
}

// ── Parsed Responses ───────────────────────────────────────────────────────

export type ActionType =
  | 'code'
  | 'talk'
  | 'move'
  | 'form_team'
  | 'join_team'
  | 'leave_team'
  | 'pitch'
  | 'chill';

export interface ParsedFooter {
  ACTION: ActionType;
  ROOM: RoomName;
  ENERGY: number;
  MOMENTUM: number;
  MORALE: number;
  TARGET?: string;
  TEAM_NAME?: string;
  PROJECT?: string;
  TRACK?: string;
}

export interface ParsedResponse {
  narrative: string;
  footer: ParsedFooter;
}

export interface ParsedSelfEval {
  narrative: string;
  progress: string;
  learnings: string[];
}

export interface ParsedMutation {
  narrative: string;
  changes: string;
  newIdentity: string;
}
