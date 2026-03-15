/**
 * store.ts — Filesystem CRUD for nanoSociety.
 * Thin wrapper around fs for reading/writing JSON state, appending JSONL logs,
 * and archiving identity versions. All simulation state lives under data/.
 */

import fs from 'node:fs';
import path from 'node:path';
import { Participant, Team, SandboxState, ParticipantInput, Judge, EvalLogEntry } from './types.js';

const DATA_DIR = path.resolve('data');
const BEINGS_DIR = path.join(DATA_DIR, 'beings');
const TEAMS_DIR = path.join(DATA_DIR, 'teams');
const ANALYSIS_DIR = path.join(DATA_DIR, 'analysis');

let participantCache: Map<string, Participant> | null = null;
let teamCache: Map<string, Team> | null = null;

export function invalidateCache(): void {
  participantCache = null;
  teamCache = null;
}

export function ensureDataDirs(): void {
  for (const dir of [DATA_DIR, BEINGS_DIR, TEAMS_DIR, ANALYSIS_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ── Generic JSON I/O ──────────────────────────────────────────────────────

export function readJSON<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

export function writeJSON(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}

export function appendJSONL(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(data) + '\n');
}

// ── Sandbox ───────────────────────────────────────────────────────────────

export function sandboxPath(): string {
  return path.join(DATA_DIR, 'sandbox.json');
}

export function loadSandbox(): SandboxState {
  return readJSON<SandboxState>(sandboxPath());
}

export function saveSandbox(state: SandboxState): void {
  writeJSON(sandboxPath(), state);
}

// ── Participants ──────────────────────────────────────────────────────────

export function participantDir(id: string): string {
  return path.join(BEINGS_DIR, id);
}

export function participantStatePath(id: string): string {
  return path.join(participantDir(id), 'state.json');
}

export function loadParticipant(id: string): Participant {
  return readJSON<Participant>(participantStatePath(id));
}

export function saveParticipant(p: Participant): void {
  if (participantCache) participantCache.set(p.id, p);
  writeJSON(participantStatePath(p.id), p);
}

export function loadAllParticipants(): Participant[] {
  if (participantCache) return Array.from(participantCache.values());
  if (!fs.existsSync(BEINGS_DIR)) return [];
  const dirs = fs.readdirSync(BEINGS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory());
  participantCache = new Map();
  for (const dir of dirs) {
    const statePath = path.join(BEINGS_DIR, dir.name, 'state.json');
    if (fs.existsSync(statePath)) {
      const p = readJSON<Participant>(statePath);
      participantCache.set(p.id, p);
    }
  }
  return Array.from(participantCache.values());
}

export function appendActionLog(id: string, entry: unknown): void {
  const logPath = path.join(participantDir(id), 'logs', 'actions.jsonl');
  appendJSONL(logPath, entry);
}

export function readActionLog(id: string): unknown[] {
  const logPath = path.join(participantDir(id), 'logs', 'actions.jsonl');
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

export function appendEvalLog(id: string, entry: EvalLogEntry): void {
  const logPath = path.join(participantDir(id), 'logs', 'evals.jsonl');
  appendJSONL(logPath, entry);
}

export function readEvalLog(id: string): EvalLogEntry[] {
  const logPath = path.join(participantDir(id), 'logs', 'evals.jsonl');
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

export function archiveIdentity(id: string, tick: number, identityMd: string): void {
  const versionPath = path.join(participantDir(id), 'identity_versions', `${tick}.md`);
  fs.mkdirSync(path.dirname(versionPath), { recursive: true });
  fs.writeFileSync(versionPath, identityMd);
}

export function listIdentityVersions(id: string): number[] {
  const versionsDir = path.join(participantDir(id), 'identity_versions');
  if (!fs.existsSync(versionsDir)) return [];
  return fs.readdirSync(versionsDir)
    .filter(f => f.endsWith('.md'))
    .map(f => parseInt(f.replace('.md', ''), 10))
    .sort((a, b) => a - b);
}

export function readIdentityVersion(id: string, tick: number): string {
  return fs.readFileSync(
    path.join(participantDir(id), 'identity_versions', `${tick}.md`),
    'utf-8',
  );
}

// ── Teams ─────────────────────────────────────────────────────────────────

export function teamPath(id: string): string {
  return path.join(TEAMS_DIR, `${id}.json`);
}

export function loadTeam(id: string): Team {
  return readJSON<Team>(teamPath(id));
}

export function saveTeam(team: Team): void {
  if (teamCache) teamCache.set(team.id, team);
  writeJSON(teamPath(team.id), team);
}

export function loadAllTeams(): Team[] {
  if (teamCache) return Array.from(teamCache.values());
  if (!fs.existsSync(TEAMS_DIR)) return [];
  teamCache = new Map();
  for (const f of fs.readdirSync(TEAMS_DIR).filter(f => f.endsWith('.json'))) {
    const t = readJSON<Team>(path.join(TEAMS_DIR, f));
    teamCache.set(t.id, t);
  }
  return Array.from(teamCache.values());
}

// ── Participants Input ────────────────────────────────────────────────────

export function loadParticipantsInput(): ParticipantInput[] {
  const inputPath = path.join(DATA_DIR, 'participants.json');
  return readJSON<ParticipantInput[]>(inputPath);
}

// ── Judges ────────────────────────────────────────────────────────────────

export function loadJudges(): Judge[] {
  const judgesPath = path.join(DATA_DIR, 'judges.json');
  if (!fs.existsSync(judgesPath)) return [];
  return readJSON<Judge[]>(judgesPath);
}

// ── Analysis ──────────────────────────────────────────────────────────────

export function writeAnalysisFile(name: string, content: string): void {
  const filePath = path.join(ANALYSIS_DIR, name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}
