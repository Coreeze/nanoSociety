/**
 * analyzer.ts — Post-simulation analysis and report generator.
 * Reads all logs, team states, and events after the simulation ends.
 * Produces: timeline, identity evolution, drama highlights, awards,
 * winner predictions per track, and an LLM-generated narrative history.
 */

import chalk from 'chalk';
import type { LLMProvider, Participant, Team, SimEvent, Judge, EvalLogEntry } from './types.js';
import { TRACKS } from './types.js';
import { buildHistoryPrompt } from './prompts.js';
import * as store from './store.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function header(title: string): string {
  const line = '═'.repeat(70);
  return `\n${chalk.bold.cyan(line)}\n${chalk.bold.cyan(`  ${title}`)}\n${chalk.bold.cyan(line)}\n`;
}

function subheader(title: string): string {
  return `\n${chalk.bold.yellow(`── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`)}\n`;
}

function stripAnsi(input: string): string {
  return input.replace(/\x1B\[[0-9;]*m/g, '');
}

function cleanDisplayText(input: string): string {
  return input.trim().replace(/^["'“”]+|["'“”]+$/g, '');
}

function escapeHtml(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatTrackLabel(trackNum: number): string {
  const raw = TRACKS[trackNum - 1];
  if (!raw) return `Track ${trackNum}`;
  const splitIdx = raw.indexOf('. ');
  return splitIdx === -1 ? raw : raw.slice(splitIdx + 2);
}

function buildParticipantMap(participants: Participant[]): Map<string, Participant> {
  return new Map(participants.map(p => [p.id, p]));
}

function stableHash(input: string): number {
  let hash = 0;
  for (const ch of input) {
    hash = ((hash * 31) + ch.charCodeAt(0)) >>> 0;
  }
  return hash;
}

function inferSubmissionTrack(participant: Participant): number {
  const text = [
    participant.goal,
    participant.identity_md,
    participant.background,
    ...participant.world_knowledge,
  ].join(' ').toLowerCase();

  if (/(benchmark|evaluate|evaluation|metric|measure|scor)/.test(text)) return 2;
  if (/(self-improv|feedback|memory|learn|refin|evolv|adapt)/.test(text)) return 3;
  if (/(game|level|asset|npc|quest|player|dev)/.test(text)) return 4;
  if (/(openclaw|orchestrator|pipeline|module|build pipeline)/.test(text)) return 5;
  if (/(skill|workflow|tool|reasoning|planning|coordination)/.test(text)) return 1;

  return (stableHash(participant.id) % TRACKS.length) + 1;
}

function buildSoloSubmission(participant: Participant): Team {
  const firstName = participant.name.trim().split(/\s+/)[0] || participant.name;
  const projectDesc = cleanDisplayText(participant.goal)
    || cleanDisplayText(participant.background)
    || 'A solo project submitted before the deadline.';

  return {
    id: `solo-submission-${participant.id}`,
    name: `${participant.name} Solo`,
    track: inferSubmissionTrack(participant),
    project_name: `${firstName}'s Solo Build`,
    project_desc: projectDesc,
    identity_md: `Solo submission by ${participant.name}.`,
    members: [participant.id],
    founded_tick: 0,
    pivots: [],
  };
}

function buildSubmittedTeams(participants: Participant[], teams: Team[]): Team[] {
  const existingTeamIds = new Set(teams.map(team => team.id));
  const submissions = [...teams];

  for (const participant of participants) {
    if (participant.team_id && existingTeamIds.has(participant.team_id)) continue;
    submissions.push(buildSoloSubmission(participant));
  }

  return submissions;
}

function findSubmittedTeamForParticipant(participant: Participant, teams: Team[]): Team | null {
  if (participant.team_id) {
    const realTeam = teams.find(candidate => candidate.id === participant.team_id);
    if (realTeam) return realTeam;
  }

  return teams.find(candidate => candidate.members.includes(participant.id)) ?? null;
}

// ── Analysis Sections ─────────────────────────────────────────────────────

function buildTimeline(events: SimEvent[]): string {
  if (events.length === 0) return '  No events recorded.';
  const significant = events.filter(e =>
    ['team_formed', 'team_left', 'pivot', 'mutation'].includes(e.type)
  );
  return significant
    .slice(0, 30)
    .map(e => `  ${chalk.dim(`[${e.time}]`)} ${chalk.white(e.description)}`)
    .join('\n');
}

function buildTeamSummaries(teams: Team[]): string {
  if (teams.length === 0) return '  No teams formed.';
  return teams.map(t => {
    const pivotStr = t.pivots.length > 0
      ? `\n    Pivots: ${t.pivots.map(p => `${p.from} → ${p.to}`).join(', ')}`
      : '';
    return `  ${chalk.bold(t.name)} [Track ${t.track}]
    Project: "${t.project_name}"
    Members: ${t.members.length}${pivotStr}`;
  }).join('\n\n');
}

function buildIdentityEvolution(participants: Participant[]): string {
  const lines: string[] = [];

  for (const p of participants) {
    const versions = store.listIdentityVersions(p.id);
    const evals = store.readEvalLog(p.id);

    if (versions.length <= 1 && evals.length === 0) continue;

    lines.push(`  ${chalk.bold.green(p.name)}:`);

    for (const tick of versions) {
      const identity = store.readIdentityVersion(p.id, tick);
      const label = tick === 0 ? 'START' : `Tick ${tick}`;
      lines.push(`    ${chalk.dim(label)}: "${identity.slice(0, 120)}${identity.length > 120 ? '...' : ''}"`);
    }
    if (versions.length > 0) {
      lines.push(`    ${chalk.dim('FINAL')}: "${p.identity_md.slice(0, 120)}${p.identity_md.length > 120 ? '...' : ''}"`);
    }

    if (evals.length > 0) {
      const progressSeq = evals.map(e => e.progress).join(' -> ');
      lines.push(`    ${chalk.dim('Progress')}: ${progressSeq}`);

      const allLearnings = evals.flatMap(e => e.learnings);
      if (allLearnings.length > 0) {
        lines.push(`    ${chalk.dim('Learnings')}: ${allLearnings.slice(0, 6).join(' | ')}`);
      }

      const first = evals[0]!;
      const last = evals[evals.length - 1]!;
      const mDelta = last.stats.momentum - first.stats.momentum;
      const moDelta = last.stats.morale - first.stats.morale;
      lines.push(`    ${chalk.dim('Stats delta')}: momentum ${mDelta >= 0 ? '+' : ''}${mDelta}, morale ${moDelta >= 0 ? '+' : ''}${moDelta}`);
    }

    lines.push('');
  }

  return lines.length > 0 ? lines.join('\n') : '  No identity mutations recorded.';
}

function buildDramaHighlights(events: SimEvent[]): string {
  const drama = events.filter(e => ['drama', 'team_left', 'pivot'].includes(e.type));
  if (drama.length === 0) return '  Surprisingly drama-free hackathon.';
  return drama
    .slice(0, 10)
    .map(e => `  ${chalk.red('!')} ${chalk.dim(`[${e.time}]`)} ${e.description}`)
    .join('\n');
}

function buildAwards(participants: Participant[], teams: Team[], events: SimEvent[]): string {
  const awards: string[] = [];

  // Pivot King — team with most pivots
  const pivotKing = [...teams].sort((a, b) => b.pivots.length - a.pivots.length)[0];
  if (pivotKing && pivotKing.pivots.length > 0) {
    awards.push(`  ${chalk.yellow('PIVOT KING')}: ${pivotKing.name} (${pivotKing.pivots.length} pivots)`);
  }

  // Lone Wolf — never joined a team
  const loneWolves = participants.filter(p => !p.team_id);
  if (loneWolves.length > 0) {
    awards.push(`  ${chalk.yellow('LONE WOLF')}: ${loneWolves.map(p => p.name).slice(0, 3).join(', ')}`);
  }

  // Drama Llama — most team_left events
  const leaveCounts = new Map<string, number>();
  for (const e of events.filter(ev => ev.type === 'team_left')) {
    const name = e.description.split(' ')[0]!;
    leaveCounts.set(name, (leaveCounts.get(name) ?? 0) + 1);
  }
  const dramaLlama = [...leaveCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (dramaLlama) {
    awards.push(`  ${chalk.yellow('DRAMA LLAMA')}: ${dramaLlama[0]} (left ${dramaLlama[1]} teams)`);
  }

  // Caffeinated — lowest energy
  const mostTired = [...participants].sort((a, b) => a.stats.energy - b.stats.energy)[0];
  if (mostTired) {
    awards.push(`  ${chalk.yellow('CAFFEINATED')}: ${mostTired.name} (energy: ${mostTired.stats.energy})`);
  }

  // Zen Master — highest morale
  const zenMaster = [...participants].sort((a, b) => b.stats.morale - a.stats.morale)[0];
  if (zenMaster) {
    awards.push(`  ${chalk.yellow('ZEN MASTER')}: ${zenMaster.name} (morale: ${zenMaster.stats.morale})`);
  }

  // Speed Demon — highest momentum
  const speedDemon = [...participants].sort((a, b) => b.stats.momentum - a.stats.momentum)[0];
  if (speedDemon) {
    awards.push(`  ${chalk.yellow('SPEED DEMON')}: ${speedDemon.name} (momentum: ${speedDemon.stats.momentum})`);
  }

  // The Politician — count talk actions from logs
  const talkCounts = new Map<string, number>();
  for (const p of participants) {
    const logs = store.readActionLog(p.id) as { action_type?: string }[];
    const talks = logs.filter(l => l.action_type === 'talk').length;
    if (talks > 0) talkCounts.set(p.name, talks);
  }
  const politician = [...talkCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (politician) {
    awards.push(`  ${chalk.yellow('THE POLITICIAN')}: ${politician[0]} (${politician[1]} talks)`);
  }

  // Team Magnet — largest team
  const biggestTeam = [...teams].sort((a, b) => b.members.length - a.members.length)[0];
  if (biggestTeam) {
    awards.push(`  ${chalk.yellow('TEAM MAGNET')}: ${biggestTeam.name} (${biggestTeam.members.length} members)`);
  }

  return awards.join('\n') || '  No awards to give.';
}

// ── Self-Improvement Metrics ──────────────────────────────────────────────

function wordOverlap(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/));
  const wordsB = new Set(b.toLowerCase().split(/\s+/));
  if (wordsA.size === 0 && wordsB.size === 0) return 1;
  const union = new Set([...wordsA, ...wordsB]);
  const intersection = [...wordsA].filter(w => wordsB.has(w));
  return union.size > 0 ? intersection.length / union.size : 0;
}

function buildSelfImprovementMetrics(participants: Participant[]): string {
  const lines: string[] = [];

  const allEvals: { id: string; evals: EvalLogEntry[] }[] = [];
  for (const p of participants) {
    const evals = store.readEvalLog(p.id);
    if (evals.length > 0) allEvals.push({ id: p.id, evals });
  }

  if (allEvals.length === 0) {
    return '  No eval data recorded (simulation may not have run long enough for self-eval ticks).';
  }

  // Improvement rate: % whose last eval is "advancing"
  const lastAdvancing = allEvals.filter(({ evals }) =>
    evals[evals.length - 1]!.progress === 'advancing'
  ).length;
  const firstAdvancing = allEvals.filter(({ evals }) =>
    evals[0]!.progress === 'advancing'
  ).length;
  lines.push(`  ${chalk.bold('Improvement Rate')}`);
  lines.push(`    First eval "advancing": ${firstAdvancing}/${allEvals.length} (${Math.round(firstAdvancing / allEvals.length * 100)}%)`);
  lines.push(`    Last eval "advancing":  ${lastAdvancing}/${allEvals.length} (${Math.round(lastAdvancing / allEvals.length * 100)}%)`);
  lines.push('');

  // Avg stats delta
  let totalMomentumDelta = 0;
  let totalMoraleDelta = 0;
  for (const { evals } of allEvals) {
    const first = evals[0]!;
    const last = evals[evals.length - 1]!;
    totalMomentumDelta += last.stats.momentum - first.stats.momentum;
    totalMoraleDelta += last.stats.morale - first.stats.morale;
  }
  const avgMom = Math.round(totalMomentumDelta / allEvals.length * 10) / 10;
  const avgMo = Math.round(totalMoraleDelta / allEvals.length * 10) / 10;
  lines.push(`  ${chalk.bold('Avg Stats Delta (first eval to last)')}`);
  lines.push(`    Momentum: ${avgMom >= 0 ? '+' : ''}${avgMom}`);
  lines.push(`    Morale:   ${avgMo >= 0 ? '+' : ''}${avgMo}`);
  lines.push('');

  // Mutation effectiveness: after a mutation, did stats improve in next eval?
  let effectiveMutations = 0;
  let totalMutations = 0;
  for (const { evals } of allEvals) {
    for (let i = 0; i < evals.length - 1; i++) {
      if (evals[i]!.changes) {
        totalMutations++;
        const before = evals[i]!.stats;
        const after = evals[i + 1]!.stats;
        if (after.momentum > before.momentum || after.morale > before.morale) {
          effectiveMutations++;
        }
      }
    }
  }
  if (totalMutations > 0) {
    lines.push(`  ${chalk.bold('Mutation Effectiveness')}`);
    lines.push(`    ${effectiveMutations}/${totalMutations} mutations led to improved stats (${Math.round(effectiveMutations / totalMutations * 100)}%)`);
    lines.push('');
  }

  // Knowledge growth
  const totalLearnings = allEvals.reduce((sum, { evals }) =>
    sum + evals.reduce((s, e) => s + e.learnings.length, 0), 0);
  const avgLearnings = Math.round(totalLearnings / allEvals.length * 10) / 10;
  lines.push(`  ${chalk.bold('Knowledge Growth')}`);
  lines.push(`    Total learnings extracted: ${totalLearnings}`);
  lines.push(`    Avg learnings per participant: ${avgLearnings}`);
  lines.push('');

  // Identity drift
  const drifts: number[] = [];
  for (const p of participants) {
    const versions = store.listIdentityVersions(p.id);
    if (versions.length < 1) continue;
    const startIdentity = store.readIdentityVersion(p.id, versions[0]!);
    const drift = 1 - wordOverlap(startIdentity, p.identity_md);
    drifts.push(drift);
  }
  if (drifts.length > 0) {
    const avgDrift = Math.round(drifts.reduce((a, b) => a + b, 0) / drifts.length * 100);
    const maxDrift = Math.round(Math.max(...drifts) * 100);
    lines.push(`  ${chalk.bold('Identity Drift')}`);
    lines.push(`    Avg identity change: ${avgDrift}%`);
    lines.push(`    Max identity change: ${maxDrift}%`);
    lines.push('');
  }

  return lines.join('\n');
}

function buildEvolutionReport(participants: Participant[]): string {
  const lines: string[] = [];
  lines.push('# Self-Improvement Evolution Report\n');
  lines.push('Track 3: Self-Improving Skills — Detailed per-participant analysis\n');

  for (const p of participants) {
    const versions = store.listIdentityVersions(p.id);
    const evals = store.readEvalLog(p.id);

    lines.push(`## ${p.name}\n`);

    // Identity timeline
    lines.push('### Identity Timeline\n');
    for (const tick of versions) {
      const identity = store.readIdentityVersion(p.id, tick);
      const label = tick === 0 ? 'START' : `Tick ${tick}`;
      lines.push(`**${label}**: ${identity}\n`);
    }
    lines.push(`**FINAL**: ${p.identity_md}\n`);

    if (evals.length > 0) {
      // Progress trajectory
      lines.push('### Progress Trajectory\n');
      lines.push(evals.map(e => `Tick ${e.tick}: **${e.progress}**`).join(' -> ') + '\n');

      // Learnings
      const allLearnings = evals.flatMap(e => e.learnings);
      if (allLearnings.length > 0) {
        lines.push('### Accumulated Learnings\n');
        allLearnings.forEach((l, i) => lines.push(`${i + 1}. ${l}`));
        lines.push('');
      }

      // Stats trajectory
      lines.push('### Stats at Each Eval\n');
      lines.push('| Tick | Energy | Momentum | Morale | Progress |');
      lines.push('|------|--------|----------|--------|----------|');
      for (const e of evals) {
        lines.push(`| ${e.tick} | ${e.stats.energy} | ${e.stats.momentum} | ${e.stats.morale} | ${e.progress} |`);
      }
      lines.push('');

      // Changes summary
      const changes = evals.filter(e => e.changes);
      if (changes.length > 0) {
        lines.push('### Mutation History\n');
        for (const e of changes) {
          lines.push(`- **Tick ${e.tick}**: ${e.changes}`);
        }
        lines.push('');
      }
    }

    lines.push('---\n');
  }

  return lines.join('\n');
}

interface RubricItem {
  criterion: string;
  weight: number;
  desc: string;
}

const RUBRIC: RubricItem[] = [
  { criterion: 'Innovation', weight: 25, desc: 'How novel and creative is the idea?' },
  { criterion: 'Execution', weight: 25, desc: 'How well was it built in the time available?' },
  { criterion: 'Track Fit', weight: 20, desc: 'How well does it address the track challenge?' },
  { criterion: 'Presentation', weight: 15, desc: 'How compelling is the pitch and demo?' },
  { criterion: 'Impact', weight: 15, desc: 'How useful or significant is this if deployed?' },
];

interface JudgeScore {
  judgeName: string;
  teamId: string;
  teamName: string;
  scores: Record<string, number>;
  total: number;
  comment: string;
}

interface TeamStanding {
  team: Team;
  trackNum: number;
  trackDesc: string;
  rank: number;
  avg: number;
  judgeScores: JudgeScore[];
  criterionAverages: Record<string, number>;
  isWinner: boolean;
  isGrandChampion: boolean;
}

interface TrackWinnerAnalysis {
  trackNum: number;
  trackDesc: string;
  standings: TeamStanding[];
}

interface WinnerAnalysis {
  judges: Judge[];
  tracks: TrackWinnerAnalysis[];
  grandChampion: TeamStanding | null;
}

interface WinnerPredictionResult {
  text: string;
  analysis: WinnerAnalysis | null;
}

async function scoreTeamByJudge(
  judge: Judge,
  team: Team,
  trackDesc: string,
  participants: Participant[],
  llm: LLMProvider,
): Promise<JudgeScore> {
  const memberNames = team.members
    .map(id => participants.find(p => p.id === id)?.name ?? id)
    .join(', ');

  const rubricStr = RUBRIC
    .map(r => `${r.criterion} (${r.weight}%): ${r.desc}`)
    .join('\n');

  const system = `You are ${judge.name} (${judge.background}), a hackathon judge.
Score this team on each criterion from 1-10. Be critical and fair. Use the full range.
Return EXACTLY these six lines and nothing else:
INNOVATION=<integer 1-10>
EXECUTION=<integer 1-10>
TRACK_FIT=<integer 1-10>
PRESENTATION=<integer 1-10>
IMPACT=<integer 1-10>
COMMENT=<one short sentence>`;

  const user = `TRACK: ${trackDesc}

TEAM: ${team.name}
PROJECT: "${team.project_name}" — ${team.project_desc}
MEMBERS: ${memberNames} (${team.members.length} people)
PIVOTS: ${team.pivots.length}${team.pivots.length > 0 ? ' — ' + team.pivots.map(p => `${p.from} → ${p.to}`).join(', ') : ''}

RUBRIC:
${rubricStr}

Return only the six requested lines.`;

  try {
    const raw = await llm.generate(system, user, 180);
    const kv: Record<string, string> = {};
    for (const line of raw.split('\n')) {
      const match = line.match(/^\s*([A-Z_ ]+)\s*[:=]\s*(.+?)\s*$/);
      if (!match) continue;
      kv[match[1]!.trim().toUpperCase().replace(/\s+/g, '_')] = match[2]!.trim();
    }
    const innovation = parseInt(kv['INNOVATION'] ?? (raw.match(/INNOVATION[^0-9]*(10|[1-9])/i)?.[1] ?? '5'), 10);
    const execution = parseInt(kv['EXECUTION'] ?? (raw.match(/EXECUTION[^0-9]*(10|[1-9])/i)?.[1] ?? '5'), 10);
    const trackFit = parseInt(kv['TRACK_FIT'] ?? (raw.match(/TRACK[_ ]FIT[^0-9]*(10|[1-9])/i)?.[1] ?? '5'), 10);
    const presentation = parseInt(kv['PRESENTATION'] ?? (raw.match(/PRESENTATION[^0-9]*(10|[1-9])/i)?.[1] ?? '5'), 10);
    const impact = parseInt(kv['IMPACT'] ?? (raw.match(/IMPACT[^0-9]*(10|[1-9])/i)?.[1] ?? '5'), 10);
    const parsedComment = kv['COMMENT']
      ?? raw.match(/COMMENT\s*[:=]\s*(.+)$/im)?.[1]?.trim()
      ?? '(comment unavailable)';

    const scores: Record<string, number> = {
      Innovation: Math.min(10, Math.max(1, innovation || 5)),
      Execution: Math.min(10, Math.max(1, execution || 5)),
      'Track Fit': Math.min(10, Math.max(1, trackFit || 5)),
      Presentation: Math.min(10, Math.max(1, presentation || 5)),
      Impact: Math.min(10, Math.max(1, impact || 5)),
    };

    const total = RUBRIC.reduce((sum, r) => sum + (scores[r.criterion]! * r.weight / 10), 0);

    return {
      judgeName: judge.name,
      teamId: team.id,
      teamName: team.name,
      scores,
      total: Math.round(total * 10) / 10,
      comment: parsedComment,
    };
  } catch {
    return {
      judgeName: judge.name,
      teamId: team.id,
      teamName: team.name,
      scores: { Innovation: 5, Execution: 5, 'Track Fit': 5, Presentation: 5, Impact: 5 },
      total: 50,
      comment: '(scoring unavailable)',
    };
  }
}

function averageCriterionScores(scores: JudgeScore[]): Record<string, number> {
  const averages: Record<string, number> = {};

  for (const rubric of RUBRIC) {
    const total = scores.reduce((sum, score) => sum + (score.scores[rubric.criterion] ?? 0), 0);
    averages[rubric.criterion] = scores.length > 0
      ? Math.round((total / scores.length) * 10) / 10
      : 0;
  }

  return averages;
}

async function buildWinnerPredictions(
  teams: Team[],
  participants: Participant[],
  llm: LLMProvider,
): Promise<WinnerPredictionResult> {
  if (teams.length === 0) {
    return { text: '  No teams to judge.', analysis: null };
  }

  const judges = store.loadJudges();
  if (judges.length === 0) {
    return { text: '  No judges panel found (data/judges.json).', analysis: null };
  }

  const trackTeams = new Map<number, Team[]>();
  for (const t of teams) {
    if (!trackTeams.has(t.track)) trackTeams.set(t.track, []);
    trackTeams.get(t.track)!.push(t);
  }

  const output: string[] = [];
  const tracks: TrackWinnerAnalysis[] = [];
  const allStandings: TeamStanding[] = [];

  // Show rubric
  output.push(chalk.dim('  Rubric:'));
  for (const r of RUBRIC) {
    output.push(chalk.dim(`    ${r.criterion} (${r.weight}%) — ${r.desc}`));
  }
  output.push('');
  output.push(chalk.dim(`  Judges panel: ${judges.map(j => `${j.name} (${j.background})`).join(', ')}`));
  output.push('');

  for (const [trackNum, tms] of [...trackTeams.entries()].sort((a, b) => a[0] - b[0])) {
    const trackDesc = TRACKS[trackNum - 1] ?? `Track ${trackNum}`;
    output.push(`  ${chalk.bold.cyan(`━━ Track ${trackNum} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)}`);

    // Score each team by each judge in parallel
    const scorePromises = tms.flatMap(team =>
      judges.map(judge => scoreTeamByJudge(judge, team, trackDesc, participants, llm))
    );
    const allScores = await Promise.all(scorePromises);

    // Aggregate per team
    const teamTotals = new Map<string, { team: Team; avg: number; scores: JudgeScore[]; criterionAverages: Record<string, number> }>();
    for (const s of allScores) {
      if (!teamTotals.has(s.teamId)) {
        const team = tms.find(candidate => candidate.id === s.teamId);
        if (!team) continue;
        teamTotals.set(s.teamId, { team, avg: 0, scores: [], criterionAverages: {} });
      }
      teamTotals.get(s.teamId)!.scores.push(s);
    }
    for (const [, data] of teamTotals) {
      data.avg = Math.round(
        (data.scores.reduce((sum, s) => sum + s.total, 0) / data.scores.length) * 10
      ) / 10;
      data.criterionAverages = averageCriterionScores(data.scores);
    }

    // Rank
    const ranked = [...teamTotals.values()]
      .sort((a, b) => b.avg - a.avg || a.team.name.localeCompare(b.team.name));
    const standings = ranked.map((data, index): TeamStanding => ({
      team: data.team,
      trackNum,
      trackDesc,
      rank: index + 1,
      avg: data.avg,
      judgeScores: data.scores,
      criterionAverages: data.criterionAverages,
      isWinner: index === 0,
      isGrandChampion: false,
    }));
    tracks.push({ trackNum, trackDesc, standings });
    allStandings.push(...standings);

    for (const standing of standings) {
      const medal = standing.isWinner ? chalk.bold.yellow('>> WINNER') : `   #${standing.rank}`;
      output.push(`  ${medal}  ${chalk.bold(standing.team.name)}  ${chalk.green(`[${standing.avg}/100]`)}`);

      for (const s of standing.judgeScores) {
        const scoreStr = Object.entries(s.scores)
          .map(([k, v]) => `${k.slice(0, 4)}:${v}`)
          .join(' ');
        output.push(chalk.dim(`         ${s.judgeName}: ${scoreStr}  "${s.comment.slice(0, 60)}"`));
      }
      output.push('');
    }
  }

  const grandChampion = [...allStandings]
    .sort((a, b) => b.avg - a.avg || a.team.name.localeCompare(b.team.name))[0] ?? null;

  if (grandChampion) {
    grandChampion.isGrandChampion = true;
    output.push(`  ${chalk.bold.green(`GRAND CHAMPION: ${grandChampion.team.name} [${grandChampion.avg}/100]`)}`);
  }

  return {
    text: output.join('\n'),
    analysis: {
      judges,
      tracks,
      grandChampion,
    },
  };
}

function buildFallbackBroadcast(
  winnerAnalysis: WinnerAnalysis | null,
  history: string,
  teams: Team[],
): string {
  const champion = winnerAnalysis?.grandChampion;
  const winnerLine = champion
    ? `Grand champion locked: ${champion.team.name} at ${champion.avg}/100.`
    : 'Judges did not produce a final champion.';
  const historyLine = history.trim() || `Five-track showdown complete. ${teams.length} teams entered the board.`;

  return [
    'CRT ANALYSIS ONLINE.',
    winnerLine,
    historyLine,
    'Search teams, projects, members, and judge takes below.',
  ].join('\n');
}

async function buildDashboardBroadcast(
  winnerAnalysis: WinnerAnalysis | null,
  history: string,
  events: SimEvent[],
  awardsStr: string,
  teams: Team[],
  llm: LLMProvider,
): Promise<string> {
  const fallback = buildFallbackBroadcast(winnerAnalysis, history, teams);
  const dramaLines = events
    .filter(event => ['drama', 'pivot', 'team_left'].includes(event.type))
    .slice(-6)
    .map(event => `[${event.time}] ${event.description}`)
    .join('\n');
  const winnerLines = winnerAnalysis
    ? winnerAnalysis.tracks
        .map(track => {
          const winner = track.standings[0];
          return winner ? `Track ${track.trackNum}: ${winner.team.name} (${winner.avg}/100)` : `Track ${track.trackNum}: undecided`;
        })
        .join('\n')
    : 'No winners available.';

  try {
    const system = `You are the voice of a retro CRT hackathon broadcast.
Write 4 short punchy lines, total under 90 words.
Be playful, slightly dramatic, and easy to read on a terminal screen.
Plain text only. No markdown bullets.`;

    const user = `GRAND CHAMPION:
${winnerAnalysis?.grandChampion ? `${winnerAnalysis.grandChampion.team.name} (${winnerAnalysis.grandChampion.avg}/100)` : 'none'}

TRACK WINNERS:
${winnerLines}

TEAMS:
${teams.map(team => `${team.name}: ${cleanDisplayText(team.project_name)}`).join('\n')}

DRAMA:
${dramaLines || 'No major drama logged.'}

AWARDS:
${stripAnsi(awardsStr) || 'No awards recorded.'}

HISTORY:
${history || 'No history summary available.'}`;

    const broadcast = (await llm.generate(system, user, 220)).trim();
    return broadcast || fallback;
  } catch {
    return fallback;
  }
}

async function renderAnalysisDashboard(
  participants: Participant[],
  teams: Team[],
  events: SimEvent[],
  awardsStr: string,
  history: string,
  winnerAnalysis: WinnerAnalysis | null,
  llm: LLMProvider,
): Promise<string> {
  const participantMap = buildParticipantMap(participants);
  const standings = winnerAnalysis?.tracks.flatMap(track => track.standings) ?? [];
  const standingByTeamId = new Map(standings.map(standing => [standing.team.id, standing]));
  const broadcast = await buildDashboardBroadcast(winnerAnalysis, history, events, awardsStr, teams, llm);
  const awardLines = stripAnsi(awardsStr)
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
  const dramaFeed = events
    .filter(event => ['drama', 'pivot', 'team_left', 'team_joined'].includes(event.type))
    .slice(-10)
    .reverse();
  const chronicle = history.trim() || 'History generation unavailable.';
  const teamsSorted = [...teams].sort((a, b) => {
    const scoreDelta = (standingByTeamId.get(b.id)?.avg ?? -1) - (standingByTeamId.get(a.id)?.avg ?? -1);
    return scoreDelta !== 0 ? scoreDelta : a.name.localeCompare(b.name);
  });
  const participantsSorted = [...participants].sort((a, b) => a.name.localeCompare(b.name));
  const totalTracks = new Set(teams.map(team => team.track)).size;
  const totalPivots = teams.reduce((sum, team) => sum + team.pivots.length, 0);
  const totalMutations = events.filter(event => event.type === 'mutation').length;
  const totalDrama = events.filter(event => event.type === 'drama').length;

  const winnerCards = winnerAnalysis?.tracks.map(track => {
    const winner = track.standings[0];
    if (!winner) return '';

    const members = winner.team.members
      .map(id => participantMap.get(id)?.name ?? id)
      .join(', ');
    const searchText = [
      `track ${track.trackNum}`,
      winner.team.name,
      cleanDisplayText(winner.team.project_name),
      cleanDisplayText(winner.team.project_desc),
      members,
      ...winner.judgeScores.map(score => score.comment),
      winner.isGrandChampion ? 'grand champion winner' : 'winner',
    ].join(' ').toLowerCase();

    return `
      <article class="panel winner-card" data-search-target="winner" data-search="${escapeHtml(searchText)}">
        <div class="eyebrow">Track ${track.trackNum} Winner</div>
        <h3>${escapeHtml(winner.team.name)}</h3>
        <div class="winner-score">${winner.avg.toFixed(1)}<span>/100</span></div>
        <p class="winner-project">${escapeHtml(cleanDisplayText(winner.team.project_name))}</p>
        <p class="winner-track">${escapeHtml(formatTrackLabel(track.trackNum))}</p>
        <p class="winner-members">Built by ${escapeHtml(members)}</p>
        <p class="winner-comment">"${escapeHtml(winner.judgeScores[0]?.comment || 'Judges approved the build.')}"</p>
      </article>`;
  }).join('') ?? `
      <article class="panel empty-panel">
        <p>Judging data unavailable.</p>
      </article>`;

  const teamCards = teamsSorted.map(team => {
    const standing = standingByTeamId.get(team.id);
    const members = team.members.map(id => participantMap.get(id)?.name ?? id);
    const memberText = members.length > 0 ? members.join(', ') : 'No members recorded';
    const scoreMeters = standing
      ? RUBRIC.map(rubric => {
          const value = standing.criterionAverages[rubric.criterion] ?? 0;
          return `
            <div class="meter-row">
              <span>${escapeHtml(rubric.criterion)}</span>
              <div class="meter-track"><div class="meter-fill" style="width:${Math.max(0, Math.min(100, value * 10))}%"></div></div>
              <strong>${value.toFixed(1)}</strong>
            </div>`;
        }).join('')
      : '<p class="muted">Judging data unavailable.</p>';
    const judgeComments = standing
      ? standing.judgeScores.map(score => `
          <li><span class="judge-name">${escapeHtml(score.judgeName)}:</span> ${escapeHtml(score.comment || '(no comment)')}</li>
        `).join('')
      : '<li>Judges panel unavailable.</li>';
    const pivotMarkup = team.pivots.length > 0
      ? `<ul class="mini-list">${team.pivots.map(pivot =>
          `<li>[${escapeHtml(pivot.time)}] ${escapeHtml(cleanDisplayText(pivot.from))} -> ${escapeHtml(cleanDisplayText(pivot.to))}</li>`
        ).join('')}</ul>`
      : '<p class="muted">No pivots recorded.</p>';
    const badges = [
      standing?.isGrandChampion ? '<span class="badge badge-champion">Grand Champion</span>' : '',
      standing?.isWinner ? '<span class="badge badge-winner">Track Winner</span>' : '',
      standing ? `<span class="badge">Rank #${standing.rank}</span>` : '',
      `<span class="badge">Track ${team.track}</span>`,
    ].join('');
    const searchText = [
      team.name,
      cleanDisplayText(team.project_name),
      cleanDisplayText(team.project_desc),
      formatTrackLabel(team.track),
      memberText,
      ...team.pivots.map(pivot => `${pivot.from} ${pivot.to}`),
      ...(standing?.judgeScores.map(score => `${score.judgeName} ${score.comment}`) ?? []),
      standing?.isGrandChampion ? 'grand champion' : '',
      standing?.isWinner ? 'winner' : '',
    ].join(' ').toLowerCase();

    return `
      <article class="panel team-card" data-search-target="team" data-search="${escapeHtml(searchText)}">
        <div class="card-topline">
          <div>
            <div class="eyebrow">Team ${escapeHtml(team.name)}</div>
            <h3>${escapeHtml(team.name)}</h3>
          </div>
          <div class="score-box">
            <span class="score-label">Judge Avg</span>
            <strong>${standing ? standing.avg.toFixed(1) : '--'}</strong>
          </div>
        </div>
        <div class="badge-row">${badges}</div>
        <div class="card-block">
          <label>What They Built</label>
          <p>${escapeHtml(cleanDisplayText(team.project_name))}</p>
          <p class="muted">${escapeHtml(cleanDisplayText(team.project_desc))}</p>
        </div>
        <div class="card-block">
          <label>Builders</label>
          <p>${escapeHtml(memberText)}</p>
        </div>
        <div class="card-block">
          <label>Track</label>
          <p>${escapeHtml(formatTrackLabel(team.track))}</p>
        </div>
        <div class="card-block">
          <label>Rubric Readout</label>
          ${scoreMeters}
        </div>
        <div class="card-block">
          <label>Judge Takes</label>
          <ul class="mini-list">${judgeComments}</ul>
        </div>
        <div class="card-block">
          <label>Pivot Log</label>
          ${pivotMarkup}
        </div>
      </article>`;
  }).join('');

  const participantCards = participantsSorted.map(participant => {
    const team = findSubmittedTeamForParticipant(participant, teams);
    const searchText = [
      participant.name,
      participant.background,
      participant.goal,
      participant.room,
      participant.identity_md,
      team?.name ?? 'solo',
      team ? cleanDisplayText(team.project_name) : '',
      ...participant.world_knowledge.slice(-5),
    ].join(' ').toLowerCase();

    return `
      <article class="panel participant-card" data-search-target="participant" data-search="${escapeHtml(searchText)}">
        <div class="card-topline">
          <div>
            <div class="eyebrow">Participant</div>
            <h3>${escapeHtml(participant.name)}</h3>
          </div>
          <div class="participant-room">${escapeHtml(participant.room.replaceAll('_', ' '))}</div>
        </div>
        <div class="badge-row">
          <span class="badge">${team ? `Team ${escapeHtml(team.name)}` : 'Solo'}</span>
          ${team ? `<span class="badge">Track ${team.track}</span>` : ''}
        </div>
        <div class="card-block">
          <label>Background</label>
          <p>${escapeHtml(participant.background)}</p>
        </div>
        <div class="card-block">
          <label>Goal</label>
          <p>${escapeHtml(participant.goal)}</p>
        </div>
        <div class="card-block">
          <label>Project</label>
          <p>${escapeHtml(team ? cleanDisplayText(team.project_name) : 'No team project')}</p>
        </div>
        <div class="card-block">
          <label>Final Stats</label>
          <div class="meter-row">
            <span>Energy</span>
            <div class="meter-track"><div class="meter-fill" style="width:${Math.max(0, Math.min(100, participant.stats.energy))}%"></div></div>
            <strong>${participant.stats.energy}</strong>
          </div>
          <div class="meter-row">
            <span>Momentum</span>
            <div class="meter-track"><div class="meter-fill" style="width:${Math.max(0, Math.min(100, participant.stats.momentum))}%"></div></div>
            <strong>${participant.stats.momentum}</strong>
          </div>
          <div class="meter-row">
            <span>Morale</span>
            <div class="meter-track"><div class="meter-fill" style="width:${Math.max(0, Math.min(100, participant.stats.morale))}%"></div></div>
            <strong>${participant.stats.morale}</strong>
          </div>
        </div>
      </article>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>nanoSociety CRT Analysis Dashboard</title>
    <style>
      :root {
        --bg: #031105;
        --bg-soft: #07200a;
        --panel: rgba(5, 26, 8, 0.82);
        --line: rgba(77, 255, 109, 0.3);
        --text: #8dff9e;
        --text-bright: #d4ffd7;
        --text-dim: #5ca866;
        --accent: #3cff72;
        --amber: #f6ff6e;
        --danger: #ff8f7f;
      }

      * {
        box-sizing: border-box;
      }

      html {
        background: #000;
      }

      body {
        margin: 0;
        min-height: 100vh;
        background:
          radial-gradient(circle at top, rgba(48, 255, 95, 0.16), transparent 35%),
          linear-gradient(180deg, #010502, #021007 45%, #010502);
        color: var(--text);
        font: 15px/1.6 "SFMono-Regular", "Menlo", "Monaco", "Consolas", "Liberation Mono", monospace;
        text-shadow: 0 0 8px rgba(61, 255, 93, 0.16);
      }

      body::after {
        content: "";
        position: fixed;
        inset: 0;
        pointer-events: none;
        background: repeating-linear-gradient(
          0deg,
          rgba(0, 0, 0, 0) 0,
          rgba(0, 0, 0, 0) 2px,
          rgba(0, 0, 0, 0.2) 3px,
          rgba(0, 0, 0, 0.2) 4px
        );
        opacity: 0.55;
      }

      [hidden] {
        display: none !important;
      }

      .screen {
        width: min(1480px, calc(100vw - 32px));
        margin: 16px auto;
        padding: 20px;
        border: 1px solid var(--line);
        background: rgba(0, 10, 2, 0.74);
        box-shadow:
          0 0 0 1px rgba(60, 255, 114, 0.08) inset,
          0 0 32px rgba(45, 255, 93, 0.12);
        position: relative;
        z-index: 1;
      }

      .masthead,
      .panel,
      .stats-grid,
      .search-wrap,
      .team-grid,
      .bottom-grid,
      .winner-grid {
        position: relative;
      }

      .masthead {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 16px;
        align-items: start;
        margin-bottom: 18px;
      }

      .bootline,
      .eyebrow,
      label,
      .score-label,
      .system-note {
        color: var(--text-dim);
        text-transform: uppercase;
        letter-spacing: 0.12em;
        font-size: 12px;
      }

      h1,
      h2,
      h3,
      p {
        margin: 0;
      }

      h1 {
        margin-top: 6px;
        color: var(--text-bright);
        font-size: clamp(28px, 5vw, 46px);
        line-height: 1.05;
      }

      .subline {
        margin-top: 10px;
        max-width: 70ch;
        color: var(--text);
      }

      .status-stack {
        display: grid;
        gap: 8px;
        justify-items: end;
      }

      .status-pill,
      .badge {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 6px 10px;
        border: 1px solid var(--line);
        background: rgba(10, 36, 12, 0.8);
      }

      .badge-row {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 12px;
      }

      .badge {
        padding: 4px 8px;
        font-size: 12px;
      }

      .badge-winner {
        color: var(--amber);
        border-color: rgba(246, 255, 110, 0.35);
      }

      .badge-champion {
        color: var(--text-bright);
        border-color: rgba(212, 255, 215, 0.45);
      }

      .panel {
        border: 1px solid var(--line);
        background: var(--panel);
        padding: 16px;
      }

      .broadcast {
        margin-bottom: 18px;
      }

      .broadcast pre,
      .chronicle {
        white-space: pre-wrap;
        color: var(--text-bright);
        margin-top: 10px;
        font: inherit;
      }

      .stats-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 12px;
        margin-bottom: 18px;
      }

      .stat-card strong {
        display: block;
        margin-top: 8px;
        color: var(--text-bright);
        font-size: 30px;
        line-height: 1;
      }

      .winner-header {
        display: flex;
        flex-wrap: wrap;
        justify-content: space-between;
        gap: 12px;
        align-items: center;
        margin-bottom: 12px;
      }

      .winner-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
        gap: 12px;
        margin-bottom: 18px;
      }

      .winner-card h3,
      .team-card h3 {
        color: var(--text-bright);
        margin-top: 6px;
      }

      .winner-score {
        margin: 12px 0 8px;
        color: var(--amber);
        font-size: 34px;
        line-height: 1;
      }

      .winner-score span {
        font-size: 16px;
        color: var(--text-dim);
      }

      .winner-project,
      .winner-track,
      .winner-members,
      .winner-comment {
        margin-top: 6px;
      }

      .search-wrap {
        margin-bottom: 18px;
      }

      .search-row {
        display: grid;
        grid-template-columns: auto 1fr auto;
        gap: 12px;
        align-items: center;
      }

      input[type="search"] {
        width: 100%;
        border: 1px solid var(--line);
        background: rgba(2, 12, 3, 0.94);
        color: var(--text-bright);
        padding: 10px 12px;
        font: inherit;
        outline: none;
      }

      input[type="search"]::placeholder {
        color: var(--text-dim);
      }

      .team-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
        gap: 12px;
      }

      .participant-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
        gap: 12px;
        margin-top: 18px;
      }

      .team-card {
        min-height: 100%;
      }

      .participant-card {
        min-height: 100%;
      }

      .card-topline {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: start;
      }

      .score-box {
        min-width: 76px;
        text-align: right;
      }

      .score-box strong {
        display: block;
        margin-top: 6px;
        color: var(--amber);
        font-size: 30px;
        line-height: 1;
      }

      .participant-room {
        color: var(--amber);
        text-align: right;
        text-transform: uppercase;
        font-size: 12px;
        letter-spacing: 0.08em;
      }

      .card-block {
        margin-top: 14px;
      }

      .card-block p + p {
        margin-top: 4px;
      }

      .meter-row {
        display: grid;
        grid-template-columns: 92px 1fr 42px;
        gap: 10px;
        align-items: center;
        margin-top: 8px;
        font-size: 13px;
      }

      .meter-track {
        height: 10px;
        border: 1px solid var(--line);
        background: rgba(0, 0, 0, 0.35);
      }

      .meter-fill {
        height: 100%;
        background: linear-gradient(90deg, rgba(61, 255, 114, 0.22), rgba(61, 255, 114, 0.9));
      }

      .mini-list {
        margin: 8px 0 0;
        padding-left: 18px;
      }

      .mini-list li + li {
        margin-top: 6px;
      }

      .judge-name {
        color: var(--text-bright);
      }

      .muted,
      .system-note {
        color: var(--text-dim);
      }

      .bottom-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
        gap: 12px;
        margin-top: 18px;
      }

      .feed-list {
        display: grid;
        gap: 10px;
        margin-top: 10px;
      }

      .feed-item {
        padding-bottom: 10px;
        border-bottom: 1px solid rgba(77, 255, 109, 0.12);
      }

      .feed-time {
        color: var(--amber);
      }

      .empty-state {
        margin-top: 18px;
        text-align: center;
        color: var(--danger);
      }

      .cursor {
        display: inline-block;
        width: 10px;
        height: 1em;
        margin-left: 6px;
        vertical-align: -2px;
        background: var(--accent);
        animation: blink 1s steps(1, end) infinite;
      }

      @keyframes blink {
        50% {
          opacity: 0;
        }
      }

      @media (max-width: 900px) {
        .masthead,
        .search-row {
          grid-template-columns: 1fr;
        }

        .status-stack {
          justify-items: start;
        }

        .score-box {
          text-align: left;
        }

        .card-topline {
          flex-direction: column;
        }
      }
    </style>
  </head>
  <body>
    <main class="screen">
      <header class="masthead">
        <div>
          <div class="bootline">POST-HACKATHON CRT ANALYZER<span class="cursor"></span></div>
          <h1>nanoSociety Dashboard</h1>
          <p class="subline">Search every team, see what they built, inspect judge takes, and spot the winners without leaving the green screen.</p>
        </div>
        <div class="status-stack">
          <div class="status-pill">SYSTEM ONLINE</div>
          <div class="status-pill">LLM JUDGING LINKED</div>
          <div class="status-pill">${escapeHtml(winnerAnalysis?.grandChampion ? `GRAND CHAMPION: ${winnerAnalysis.grandChampion.team.name}` : 'CHAMPION PENDING')}</div>
        </div>
      </header>

      <section class="panel broadcast">
        <div class="eyebrow">AI Broadcast</div>
        <pre>${escapeHtml(broadcast)}</pre>
      </section>

      <section class="stats-grid">
        <article class="panel stat-card">
          <div class="eyebrow">Teams</div>
          <strong>${teams.length}</strong>
          <p class="system-note">${totalTracks} active tracks</p>
        </article>
        <article class="panel stat-card">
          <div class="eyebrow">Participants</div>
          <strong>${participants.length}</strong>
          <p class="system-note">across the full simulation</p>
        </article>
        <article class="panel stat-card">
          <div class="eyebrow">Mutations</div>
          <strong>${totalMutations}</strong>
          <p class="system-note">self-improvement events logged</p>
        </article>
        <article class="panel stat-card">
          <div class="eyebrow">Drama Events</div>
          <strong>${totalDrama}</strong>
          <p class="system-note">chaotic moments detected</p>
        </article>
        <article class="panel stat-card">
          <div class="eyebrow">Pivots</div>
          <strong>${totalPivots}</strong>
          <p class="system-note">project direction changes</p>
        </article>
      </section>

      <section class="panel">
        <div class="winner-header">
          <div>
            <div class="eyebrow">Winner Board</div>
            <h2>Who Won</h2>
          </div>
          <div class="status-pill">${escapeHtml(
            winnerAnalysis?.grandChampion
              ? `${winnerAnalysis.grandChampion.team.name} leads at ${winnerAnalysis.grandChampion.avg.toFixed(1)}/100`
              : 'No overall champion available'
          )}</div>
        </div>
        <div class="winner-grid">
          ${winnerCards}
        </div>
      </section>

      <section class="panel search-wrap">
        <div class="search-row">
          <label for="team-search">Search Index</label>
          <input id="team-search" type="search" placeholder="Search participant, team, project, member, judge quote..." autocomplete="off" />
          <div id="search-count" class="system-note"></div>
        </div>
      </section>

      <section id="team-grid" class="team-grid">
        ${teamCards}
      </section>

      <section class="panel" style="margin-top: 18px;">
        <div class="winner-header">
          <div>
            <div class="eyebrow">Participant Index</div>
            <h2>People</h2>
          </div>
          <div id="participant-count" class="status-pill"></div>
        </div>
        <section id="participant-grid" class="participant-grid">
          ${participantCards}
        </section>
      </section>

      <div id="empty-state" class="empty-state" hidden>No teams match the current search.</div>

      <section class="bottom-grid">
        <article class="panel">
          <div class="eyebrow">Official Chronicle</div>
          <div class="chronicle">${escapeHtml(chronicle)}</div>
        </article>
        <article class="panel">
          <div class="eyebrow">Drama Feed</div>
          <div class="feed-list">
            ${dramaFeed.length > 0
              ? dramaFeed.map(event => `
                  <div class="feed-item">
                    <div class="feed-time">[${escapeHtml(event.time)}] ${escapeHtml(event.type.toUpperCase())}</div>
                    <div>${escapeHtml(event.description)}</div>
                  </div>
                `).join('')
              : '<div class="system-note">No drama feed available.</div>'}
          </div>
        </article>
        <article class="panel">
          <div class="eyebrow">Awards</div>
          <div class="feed-list">
            ${awardLines.length > 0
              ? awardLines.map(line => `<div class="feed-item">${escapeHtml(line)}</div>`).join('')
              : '<div class="system-note">No awards recorded.</div>'}
          </div>
        </article>
      </section>
    </main>

    <script>
      (function () {
        const searchInput = document.getElementById('team-search');
        const countNode = document.getElementById('search-count');
        const participantCountNode = document.getElementById('participant-count');
        const emptyState = document.getElementById('empty-state');
        const teamCards = Array.from(document.querySelectorAll('[data-search-target="team"]'));
        const participantCards = Array.from(document.querySelectorAll('[data-search-target="participant"]'));
        const winnerCards = Array.from(document.querySelectorAll('[data-search-target="winner"]'));

        function applySearch() {
          const query = String(searchInput.value || '').trim().toLowerCase();
          const tokens = query.split(/\\s+/).filter(Boolean);
          let visibleTeams = 0;
          let visibleParticipants = 0;

          for (const card of teamCards) {
            const haystack = String(card.getAttribute('data-search') || '').toLowerCase();
            const match = tokens.every(function (token) {
              return haystack.indexOf(token) !== -1;
            });
            card.hidden = !match;
            if (match) visibleTeams += 1;
          }

          for (const card of participantCards) {
            const haystack = String(card.getAttribute('data-search') || '').toLowerCase();
            const match = tokens.every(function (token) {
              return haystack.indexOf(token) !== -1;
            });
            card.hidden = !match;
            if (match) visibleParticipants += 1;
          }

          for (const card of winnerCards) {
            const haystack = String(card.getAttribute('data-search') || '').toLowerCase();
            const match = tokens.length === 0 || tokens.every(function (token) {
              return haystack.indexOf(token) !== -1;
            });
            card.hidden = !match;
          }

          countNode.textContent = visibleTeams + ' / ' + teamCards.length + ' teams visible';
          participantCountNode.textContent = visibleParticipants + ' / ' + participantCards.length + ' participants visible';
          emptyState.hidden = visibleTeams !== 0 || visibleParticipants !== 0;
        }

        searchInput.addEventListener('input', applySearch);
        applySearch();
      })();
    </script>
  </body>
</html>`;
}

// ── Main Analyzer ─────────────────────────────────────────────────────────

export async function runAnalysis(llm: LLMProvider): Promise<void> {
  const sandbox = store.loadSandbox();
  const participants = store.loadAllParticipants();
  const recordedTeams = store.loadAllTeams();
  const teams = buildSubmittedTeams(participants, recordedTeams);
  let history = '';

  console.log(header('NANOSOCIETY — HACKATHON ANALYSIS'));

  // 1. Timeline
  console.log(subheader('TIMELINE OF MAJOR EVENTS'));
  const timelineStr = buildTimeline(sandbox.events);
  console.log(timelineStr);

  // 2. Teams & Projects
  console.log(subheader('TEAMS & PROJECTS'));
  const teamStr = buildTeamSummaries(teams);
  console.log(teamStr);

  // 3. Identity Evolution (Track 3 showcase — all participants)
  console.log(subheader('IDENTITY EVOLUTION (Track 3 Showcase)'));
  const identityStr = buildIdentityEvolution(participants);
  console.log(identityStr);

  // 3b. Self-Improvement Metrics
  console.log(subheader('SELF-IMPROVEMENT METRICS'));
  const metricsStr = buildSelfImprovementMetrics(participants);
  console.log(metricsStr);

  // 4. Drama Highlights
  console.log(subheader('DRAMA HIGHLIGHTS'));
  const dramaStr = buildDramaHighlights(sandbox.events);
  console.log(dramaStr);

  // 5. Awards
  console.log(subheader('AWARDS'));
  const awardsStr = buildAwards(participants, recordedTeams, sandbox.events);
  console.log(awardsStr);

  // 6. Winner Predictions
  console.log(subheader('WINNER PREDICTIONS'));
  const winnerResult = await buildWinnerPredictions(teams, participants, llm);
  const winnersStr = winnerResult.text;
  console.log(winnersStr);

  // 7. The History
  console.log(subheader('THE HISTORY OF THE HACKATHON'));
  try {
    const { system, user } = buildHistoryPrompt(timelineStr, teamStr, dramaStr, winnersStr);
    history = await llm.generate(system, user);
    console.log(`  ${history}`);
    store.writeAnalysisFile('history.md', history);
  } catch {
    console.log('  (History generation failed)');
  }

  // Save report
  const reportLines = [
    '# nanoSociety Hackathon Analysis\n',
    '## Timeline\n', timelineStr, '\n',
    '## Teams & Projects\n', teamStr, '\n',
    '## Identity Evolution\n', identityStr, '\n',
    '## Self-Improvement Metrics\n', metricsStr, '\n',
    '## Drama Highlights\n', dramaStr, '\n',
    '## Awards\n', awardsStr, '\n',
    '## Winner Predictions\n', winnersStr, '\n',
  ];
  store.writeAnalysisFile('report.md', reportLines.join('\n'));

  // Save detailed evolution report
  const evolutionReport = buildEvolutionReport(participants);
  store.writeAnalysisFile('evolution.md', evolutionReport);

  // Save searchable CRT dashboard
  const dashboardHtml = await renderAnalysisDashboard(
    participants,
    teams,
    sandbox.events,
    awardsStr,
    history,
    winnerResult.analysis,
    llm,
  );
  store.writeAnalysisFile('dashboard.html', dashboardHtml);

  console.log(header('REPORT SAVED TO data/analysis/'));
  console.log(chalk.green('  Dashboard saved to data/analysis/dashboard.html'));
}
