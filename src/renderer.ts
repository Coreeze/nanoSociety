/**
 * renderer.ts — ASCII floor plan renderer for the AGI House.
 * Renders the simulation state in-place using an alternate screen buffer
 * and ANSI escape codes. No scrolling — the frame overwrites each tick.
 */

import chalk from 'chalk';
import type { Participant, Team, RoomName, PhaseName } from './types.js';

// ── Fullscreen Management ─────────────────────────────────────────────────

export function enterFullscreen(): void {
  process.stdout.write('\x1b[?1049h\x1b[?25l');
}

export function exitFullscreen(): void {
  process.stdout.write('\x1b[?25h\x1b[?1049l');
}

// ── Color Assignment ──────────────────────────────────────────────────────

const TEAM_COLORS = [
  chalk.cyan, chalk.magenta, chalk.yellow, chalk.green,
  chalk.red, chalk.blue, chalk.white, chalk.gray,
  chalk.cyanBright, chalk.magentaBright, chalk.yellowBright, chalk.greenBright,
  chalk.redBright, chalk.blueBright, chalk.whiteBright,
];

const teamColorMap = new Map<string, (text: string) => string>();
let nextColorIdx = 0;

function getTeamColor(teamId: string): (text: string) => string {
  if (!teamColorMap.has(teamId)) {
    teamColorMap.set(teamId, TEAM_COLORS[nextColorIdx % TEAM_COLORS.length]!);
    nextColorIdx++;
  }
  return teamColorMap.get(teamId)!;
}

function getInitials(name: string): string {
  const parts = name.split(/\s+/);
  if (parts.length >= 2) return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

// ── Room Content Builder ──────────────────────────────────────────────────

function buildRoomContent(
  room: RoomName,
  participants: Participant[],
  teams: Team[],
  maxWidth: number,
): string[] {
  const inRoom = participants.filter(p => p.room === room);
  if (inRoom.length === 0) return ['  (empty)'];

  const teamGroups = new Map<string, Participant[]>();
  const solos: Participant[] = [];

  for (const p of inRoom) {
    if (p.team_id) {
      if (!teamGroups.has(p.team_id)) teamGroups.set(p.team_id, []);
      teamGroups.get(p.team_id)!.push(p);
    } else {
      solos.push(p);
    }
  }

  const lines: string[] = [];

  for (const [teamId, members] of teamGroups) {
    const team = teams.find(t => t.id === teamId);
    const color = getTeamColor(teamId);
    const label = team ? team.name : teamId;
    const initials = members.map(m => color(getInitials(m.name))).join(' ');
    const line = `  ${color(`[${label}]`)} ${initials}`;
    lines.push(line);
  }

  if (solos.length > 0) {
    const chunks: string[] = [];
    for (const p of solos) {
      chunks.push(chalk.dim(getInitials(p.name)));
    }
    let line = '  ';
    for (const chunk of chunks) {
      line += chunk + ' ';
    }
    lines.push(line.trimEnd());
  }

  return lines;
}

// ── Action Log Entry ──────────────────────────────────────────────────────

export interface LogEntry {
  name: string;
  action: string;
  actionType: string;
  teamId?: string | null;
}

// ── Frame Builder ─────────────────────────────────────────────────────────

const W = 80;

function pad(str: string, width: number): string {
  const visibleLen = str.replace(/\x1b\[[0-9;]*m/g, '').length;
  const padding = Math.max(0, width - visibleLen);
  return str + ' '.repeat(padding);
}

function boxLine(content: string, width: number): string {
  return '║ ' + pad(content, width - 4) + ' ║';
}

function roomBox(
  label: string,
  contentLines: string[],
  boxWidth: number,
): string[] {
  const inner = boxWidth - 4;
  const lines: string[] = [];
  lines.push('┌─' + label + '─'.repeat(Math.max(0, inner - label.length - 1)) + '┐');
  for (const cl of contentLines) {
    lines.push('│ ' + pad(cl, inner) + ' │');
  }
  lines.push('└' + '─'.repeat(inner + 2) + '┘');
  return lines;
}

export function buildFrame(
  tick: number,
  totalTicks: number,
  time: string,
  phase: PhaseName,
  participants: Participant[],
  teams: Team[],
  recentLogs: LogEntry[],
): string {
  const soloCount = participants.filter(p => !p.team_id).length;
  const header = `═══ AGI HOUSE ══════════════════════ TICK ${tick}/${totalTicks} ═ ${time} ═ ${phase} ═══`;

  const lines: string[] = [];
  lines.push('╔' + pad(header, W - 2) + '╗');
  lines.push(boxLine('', W));

  const mainContent = buildRoomContent('MAIN_ROOM', participants, teams, 40);
  const frontContent = buildRoomContent('FRONT_GARDEN', participants, teams, 18);
  const kitchenContent = buildRoomContent('KITCHEN', participants, teams, 22);
  const barContent = buildRoomContent('BAR', participants, teams, 14);
  const backContent = buildRoomContent('BACK_GARDEN', participants, teams, 18);
  const officeContent = buildRoomContent('OFFICE', participants, teams, 14);
  const stairsContent = buildRoomContent('STAIRS', participants, teams, 14);
  const secondContent = buildRoomContent('SECOND_FLOOR', participants, teams, 14);
  const storageContent = buildRoomContent('STORAGE', participants, teams, 14);
  const bathroomContent = buildRoomContent('BATHROOM', participants, teams, 14);

  const frontBox = roomBox('FRONT GARDEN', frontContent, 22);
  const mainBox = roomBox('MAIN ROOM', mainContent, 44);

  const maxRows = Math.max(frontBox.length, mainBox.length);
  for (let i = 0; i < maxRows; i++) {
    const left = i < frontBox.length ? frontBox[i]! : ' '.repeat(22);
    const conn = i === Math.floor(maxRows / 2) ? '───' : '   ';
    const right = i < mainBox.length ? mainBox[i]! : ' '.repeat(44);
    lines.push(boxLine(`${left}${conn}${right}`, W));
  }

  lines.push(boxLine('', W));

  const barBox = roomBox('BAR', barContent, 18);
  const kitchenBox = roomBox('KITCHEN', kitchenContent, 26);
  const backBox = roomBox('BACK GARDEN', backContent, 20);

  const midRows = Math.max(barBox.length, kitchenBox.length, backBox.length);
  for (let i = 0; i < midRows; i++) {
    const left = i < barBox.length ? barBox[i]! : ' '.repeat(18);
    const c1 = i === Math.floor(midRows / 2) ? '──' : '  ';
    const mid = i < kitchenBox.length ? kitchenBox[i]! : ' '.repeat(26);
    const c2 = i === Math.floor(midRows / 2) ? '──' : '  ';
    const right = i < backBox.length ? backBox[i]! : ' '.repeat(20);
    lines.push(boxLine(`${left}${c1}${mid}${c2}${right}`, W));
  }

  lines.push(boxLine('', W));

  const officeBox = roomBox('OFFICE', officeContent, 18);
  const stairsBox = roomBox('STAIRS/2F', [...stairsContent, ...secondContent], 20);
  const miscContent = [...bathroomContent.map(l => `WC: ${l}`), ...storageContent.map(l => `ST: ${l}`)];
  const miscBox = roomBox('BATH+STOR', miscContent.length > 0 ? miscContent : ['  (empty)'], 20);

  const botRows = Math.max(officeBox.length, stairsBox.length, miscBox.length);
  for (let i = 0; i < botRows; i++) {
    const left = i < officeBox.length ? officeBox[i]! : ' '.repeat(18);
    const c1 = i === Math.floor(botRows / 2) ? '──' : '  ';
    const mid = i < stairsBox.length ? stairsBox[i]! : ' '.repeat(20);
    const c2 = '  ';
    const right = i < miscBox.length ? miscBox[i]! : ' '.repeat(20);
    lines.push(boxLine(`${left}${c1}${mid}${c2}${right}`, W));
  }

  lines.push(boxLine('', W));
  lines.push('╠' + '═'.repeat(W - 2) + '╣');

  const logSlice = recentLogs.slice(-5);
  if (logSlice.length === 0) {
    lines.push(boxLine(chalk.dim('Waiting for first actions...'), W));
  }
  for (const entry of logSlice) {
    const color = entry.teamId ? getTeamColor(entry.teamId) : chalk.dim;
    const tag = chalk.dim(`[${entry.actionType}]`);
    const text = `${color(entry.name)}: ${entry.action.slice(0, 55)}`;
    lines.push(boxLine(`${text}  ${tag}`, W));
  }

  lines.push('╠' + '═'.repeat(W - 2) + '╣');
  const statusLine = `TEAMS: ${teams.length}  │  SOLO: ${soloCount}  │  POP: ${participants.length}  │  ${phase}`;
  lines.push(boxLine(statusLine, W));
  lines.push('╚' + '═'.repeat(W - 2) + '╝');

  return lines.join('\n');
}

export function renderFrame(frame: string): void {
  process.stdout.write('\x1b[H' + frame);
}
