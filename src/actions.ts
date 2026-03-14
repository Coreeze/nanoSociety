/**
 * actions.ts — Parse LLM text+footer responses and apply side-effects.
 * The LLM returns free narrative text followed by --- and KEY: value pairs.
 * This module parses that format and modifies simulation state accordingly.
 */

import type {
  Participant, Team, ParsedFooter, ParsedResponse, ParsedSelfEval,
  ParsedMutation, ActionType, RoomName, SimEvent,
} from './types.js';
import { ROOM_ADJACENCY, ROOM_NAMES } from './types.js';
import * as store from './store.js';

// ── Parsing ────────────────────────────────────────────────────────────────

function splitResponse(raw: string): { narrative: string; footerLines: string[] } {
  const parts = raw.split('---');
  const narrative = parts[0]?.trim() ?? '';
  const footerRaw = parts.slice(1).join('---').trim();
  const footerLines = footerRaw
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);
  return { narrative, footerLines };
}

function parseKeyValue(lines: string[]): Record<string, string> {
  const kv: Record<string, string> = {};
  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim().toUpperCase();
    const value = line.slice(colonIdx + 1).trim();
    kv[key] = value;
  }
  return kv;
}

const VALID_ACTIONS: ActionType[] = ['code', 'talk', 'move', 'form_team', 'join_team', 'leave_team', 'pitch', 'chill'];

export function parseActionResponse(raw: string): ParsedResponse {
  const { narrative, footerLines } = splitResponse(raw);
  const kv = parseKeyValue(footerLines);

  let action = (kv['ACTION'] ?? 'chill').toLowerCase() as ActionType;
  if (!VALID_ACTIONS.includes(action)) action = 'chill';

  let room = (kv['ROOM'] ?? 'MAIN_ROOM').toUpperCase() as RoomName;
  if (!ROOM_NAMES.includes(room)) room = 'MAIN_ROOM';

  return {
    narrative,
    footer: {
      ACTION: action,
      ROOM: room,
      ENERGY: parseInt(kv['ENERGY'] ?? '0', 10) || 0,
      MOMENTUM: parseInt(kv['MOMENTUM'] ?? '0', 10) || 0,
      MORALE: parseInt(kv['MORALE'] ?? '0', 10) || 0,
      TARGET: kv['TARGET'],
      TEAM_NAME: kv['TEAM_NAME'],
      PROJECT: kv['PROJECT'],
      TRACK: kv['TRACK'],
    },
  };
}

export function parseSelfEvalResponse(raw: string): ParsedSelfEval {
  const { narrative, footerLines } = splitResponse(raw);
  const kv = parseKeyValue(footerLines);

  return {
    narrative,
    progress: kv['PROGRESS'] ?? 'stagnant',
    learnings: (kv['LEARNINGS'] ?? '')
      .split('|')
      .map(l => l.trim())
      .filter(Boolean),
  };
}

export function parseMutationResponse(raw: string): ParsedMutation {
  const { narrative, footerLines } = splitResponse(raw);
  const kv = parseKeyValue(footerLines);

  return {
    narrative,
    changes: kv['CHANGES'] ?? '',
    newIdentity: kv['NEW_IDENTITY'] ?? '',
  };
}

export function parseSeedResponse(raw: string): { identity: string; goal: string } {
  const { footerLines } = splitResponse(raw);
  const kv = parseKeyValue(footerLines);
  return {
    identity: kv['IDENTITY'] ?? 'A hackathon participant ready to build something great.',
    goal: kv['GOAL'] ?? 'Build something impressive and win.',
  };
}

// ── Batch Parsing ────────────────────────────────────────────────────────

export function parseBatchActionResponse(
  raw: string,
  participantNames: string[],
): Map<string, ParsedResponse> {
  const results = new Map<string, ParsedResponse>();

  const namePattern = participantNames
    .map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const regex = new RegExp(`\\[\\s*(${namePattern})\\s*\\]`, 'gi');

  const markers: { name: string; index: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(raw)) !== null) {
    const matchedName = participantNames.find(
      n => n.toLowerCase() === match![1]!.toLowerCase()
    );
    if (matchedName) {
      markers.push({ name: matchedName, index: match.index });
    }
  }

  for (let i = 0; i < markers.length; i++) {
    const start = markers[i]!.index + markers[i]!.name.length + 2; // skip [NAME]
    const end = i + 1 < markers.length ? markers[i + 1]!.index : raw.length;
    const block = raw.slice(start, end).trim();

    try {
      const parsed = parseActionResponse(block);
      results.set(markers[i]!.name, parsed);
    } catch {
      // skip malformed block
    }
  }

  // Default missing participants to chill
  for (const name of participantNames) {
    if (!results.has(name)) {
      results.set(name, {
        narrative: '',
        footer: {
          ACTION: 'chill',
          ROOM: 'MAIN_ROOM',
          ENERGY: 0,
          MOMENTUM: 0,
          MORALE: 0,
        },
      });
    }
  }

  return results;
}

// ── Side-Effects ──────────────────────────────────────────────────────────

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

export function applyStatChanges(p: Participant, footer: ParsedFooter): void {
  p.stats.energy = clamp(p.stats.energy + footer.ENERGY, 0, 100);
  p.stats.momentum = clamp(p.stats.momentum + footer.MOMENTUM, 0, 100);
  p.stats.morale = clamp(p.stats.morale + footer.MORALE, 0, 100);
}

export function applyRoomMove(p: Participant, targetRoom: RoomName): void {
  if (targetRoom === p.room) return;
  const adjacent = ROOM_ADJACENCY[p.room];
  if (adjacent.includes(targetRoom)) {
    p.room = targetRoom;
  }
}

export interface ActionResult {
  events: SimEvent[];
  newTeam?: Team;
}

export function applyAction(
  participant: Participant,
  parsed: ParsedResponse,
  allParticipants: Participant[],
  allTeams: Team[],
  tick: number,
  time: string,
): ActionResult {
  const { footer } = parsed;
  const events: SimEvent[] = [];
  let newTeam: Team | undefined;

  applyStatChanges(participant, footer);
  applyRoomMove(participant, footer.ROOM);

  switch (footer.ACTION) {
    case 'form_team': {
      if (participant.team_id) break;
      const teamName = footer.TEAM_NAME || `Team ${participant.name.split(' ')[0]}`;
      const teamId = slugify(teamName);
      const track = parseInt(footer.TRACK ?? '3', 10);

      newTeam = {
        id: teamId,
        name: teamName,
        track: clamp(track, 1, 5),
        project_name: footer.PROJECT || 'Untitled Project',
        project_desc: footer.PROJECT || 'A hackathon project',
        identity_md: `We are ${teamName}, building "${footer.PROJECT || 'our project'}" for Track ${track}.`,
        members: [participant.id],
        founded_tick: tick,
        pivots: [],
      };

      if (footer.TARGET) {
        const targetId = slugify(footer.TARGET);
        const target = allParticipants.find(
          p => p.id === targetId || slugify(p.name) === targetId
        );
        if (target && !target.team_id) {
          target.team_id = teamId;
          newTeam.members.push(target.id);
        }
      }

      participant.team_id = teamId;
      events.push({
        tick, time, type: 'team_formed',
        description: `${participant.name} formed "${teamName}" (Track ${track}: ${footer.PROJECT || 'TBD'})`,
      });
      break;
    }

    case 'join_team': {
      if (participant.team_id) break;
      const targetTeamId = footer.TARGET ? slugify(footer.TARGET) : null;
      const team = targetTeamId
        ? allTeams.find(t => t.id === targetTeamId || slugify(t.name) === targetTeamId)
        : allTeams.find(t => t.members.some(mId => {
            const m = allParticipants.find(p => p.id === mId);
            return m && m.room === participant.room;
          }));

      if (team) {
        participant.team_id = team.id;
        team.members.push(participant.id);
        events.push({
          tick, time, type: 'team_joined',
          description: `${participant.name} joined ${team.name}`,
        });
      }
      break;
    }

    case 'leave_team': {
      if (!participant.team_id) break;
      const team = allTeams.find(t => t.id === participant.team_id);
      if (team) {
        team.members = team.members.filter(id => id !== participant.id);
        events.push({
          tick, time, type: 'team_left',
          description: `${participant.name} left ${team.name}!`,
        });
      }
      participant.team_id = null;
      break;
    }

    default:
      break;
  }

  return { events, newTeam };
}

export function applyTeamAction(
  team: Team,
  parsed: ParsedResponse,
  members: Participant[],
  tick: number,
  time: string,
): SimEvent[] {
  const { footer } = parsed;
  const events: SimEvent[] = [];

  for (const member of members) {
    applyStatChanges(member, footer);
    if (footer.ROOM && footer.ROOM !== member.room) {
      applyRoomMove(member, footer.ROOM);
    }
  }

  if (footer.ACTION === 'move' && footer.ROOM) {
    for (const member of members) {
      member.room = footer.ROOM;
    }
  }

  if (footer.PROJECT && footer.PROJECT !== team.project_name) {
    team.pivots.push({
      tick, time,
      from: team.project_name,
      to: footer.PROJECT,
    });
    team.project_desc = footer.PROJECT;
    team.project_name = footer.PROJECT;
    events.push({
      tick, time, type: 'pivot',
      description: `${team.name} pivoted to "${footer.PROJECT}"`,
    });
  }

  return events;
}
