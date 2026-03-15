/**
 * analyzer.ts — Post-simulation analysis and report generator.
 * Reads all logs, team states, and events after the simulation ends.
 * Produces: timeline, identity evolution, drama highlights, awards,
 * winner predictions per track, and an LLM-generated narrative history.
 */

import chalk from 'chalk';
import type { LLMProvider, Participant, Team, SimEvent, Judge, EvalLogEntry } from './types.js';
import { TRACKS, HACKATHON_START_HOUR } from './types.js';
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
  const drama = events.filter(e => ['team_left', 'pivot'].includes(e.type));
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

const RUBRIC = [
  { criterion: 'Innovation', weight: 25, desc: 'How novel and creative is the idea?' },
  { criterion: 'Execution', weight: 25, desc: 'How well was it built in the time available?' },
  { criterion: 'Track Fit', weight: 20, desc: 'How well does it address the track challenge?' },
  { criterion: 'Presentation', weight: 15, desc: 'How compelling is the pitch and demo?' },
  { criterion: 'Impact', weight: 15, desc: 'How useful or significant is this if deployed?' },
];

interface JudgeScore {
  judgeName: string;
  teamName: string;
  scores: Record<string, number>;
  total: number;
  comment: string;
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
Score this team on each criterion from 1-10. Be critical and fair.

End with --- footer:
INNOVATION: score 1-10
EXECUTION: score 1-10
TRACK_FIT: score 1-10
PRESENTATION: score 1-10
IMPACT: score 1-10
COMMENT: one sentence overall assessment`;

  const user = `TRACK: ${trackDesc}

TEAM: ${team.name}
PROJECT: "${team.project_name}" — ${team.project_desc}
MEMBERS: ${memberNames} (${team.members.length} people)
PIVOTS: ${team.pivots.length}${team.pivots.length > 0 ? ' — ' + team.pivots.map(p => `${p.from} → ${p.to}`).join(', ') : ''}

RUBRIC:
${rubricStr}

Score this team. Max 5 words, then --- footer.`;

  try {
    const raw = await llm.generate(system, user);
    const parts = raw.split('---');
    const footerRaw = parts.slice(1).join('---');
    const kv: Record<string, string> = {};
    for (const line of footerRaw.split('\n')) {
      const ci = line.indexOf(':');
      if (ci === -1) continue;
      kv[line.slice(0, ci).trim().toUpperCase()] = line.slice(ci + 1).trim();
    }

    const scores: Record<string, number> = {
      Innovation: Math.min(10, Math.max(1, parseInt(kv['INNOVATION'] ?? '5', 10) || 5)),
      Execution: Math.min(10, Math.max(1, parseInt(kv['EXECUTION'] ?? '5', 10) || 5)),
      'Track Fit': Math.min(10, Math.max(1, parseInt(kv['TRACK_FIT'] ?? '5', 10) || 5)),
      Presentation: Math.min(10, Math.max(1, parseInt(kv['PRESENTATION'] ?? '5', 10) || 5)),
      Impact: Math.min(10, Math.max(1, parseInt(kv['IMPACT'] ?? '5', 10) || 5)),
    };

    const total = RUBRIC.reduce((sum, r) => sum + (scores[r.criterion]! * r.weight / 10), 0);

    return {
      judgeName: judge.name,
      teamName: team.name,
      scores,
      total: Math.round(total * 10) / 10,
      comment: kv['COMMENT'] ?? '',
    };
  } catch {
    return {
      judgeName: judge.name,
      teamName: team.name,
      scores: { Innovation: 5, Execution: 5, 'Track Fit': 5, Presentation: 5, Impact: 5 },
      total: 50,
      comment: '(scoring unavailable)',
    };
  }
}

async function buildWinnerPredictions(
  teams: Team[],
  participants: Participant[],
  llm: LLMProvider,
): Promise<string> {
  if (teams.length === 0) return '  No teams to judge.';

  const judges = store.loadJudges();
  if (judges.length === 0) return '  No judges panel found (data/judges.json).';

  const trackTeams = new Map<number, Team[]>();
  for (const t of teams) {
    if (!trackTeams.has(t.track)) trackTeams.set(t.track, []);
    trackTeams.get(t.track)!.push(t);
  }

  const output: string[] = [];

  // Show rubric
  output.push(chalk.dim('  Rubric:'));
  for (const r of RUBRIC) {
    output.push(chalk.dim(`    ${r.criterion} (${r.weight}%) — ${r.desc}`));
  }
  output.push('');
  output.push(chalk.dim(`  Judges panel: ${judges.map(j => `${j.name} (${j.background})`).join(', ')}`));
  output.push('');

  for (const [trackNum, tms] of trackTeams) {
    const trackDesc = TRACKS[trackNum - 1] ?? `Track ${trackNum}`;
    output.push(`  ${chalk.bold.cyan(`━━ Track ${trackNum} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)}`);

    const allScores: JudgeScore[] = [];

    // Score each team by each judge in parallel
    const scorePromises = tms.flatMap(team =>
      judges.map(judge => scoreTeamByJudge(judge, team, trackDesc, participants, llm))
    );
    const scores = await Promise.all(scorePromises);
    allScores.push(...scores);

    // Aggregate per team
    const teamTotals = new Map<string, { avg: number; scores: JudgeScore[] }>();
    for (const s of allScores) {
      if (!teamTotals.has(s.teamName)) teamTotals.set(s.teamName, { avg: 0, scores: [] });
      teamTotals.get(s.teamName)!.scores.push(s);
    }
    for (const [name, data] of teamTotals) {
      data.avg = Math.round(
        (data.scores.reduce((sum, s) => sum + s.total, 0) / data.scores.length) * 10
      ) / 10;
    }

    // Rank
    const ranked = [...teamTotals.entries()].sort((a, b) => b[1].avg - a[1].avg);

    for (let i = 0; i < ranked.length; i++) {
      const [name, data] = ranked[i]!;
      const medal = i === 0 ? chalk.bold.yellow('>> WINNER') : `   #${i + 1}`;
      output.push(`  ${medal}  ${chalk.bold(name)}  ${chalk.green(`[${data.avg}/100]`)}`);

      for (const s of data.scores) {
        const scoreStr = Object.entries(s.scores)
          .map(([k, v]) => `${k.slice(0, 4)}:${v}`)
          .join(' ');
        output.push(chalk.dim(`         ${s.judgeName}: ${scoreStr}  "${s.comment.slice(0, 60)}"`));
      }
      output.push('');
    }
  }

  return output.join('\n');
}

// ── Main Analyzer ─────────────────────────────────────────────────────────

export async function runAnalysis(llm: LLMProvider): Promise<void> {
  const sandbox = store.loadSandbox();
  const participants = store.loadAllParticipants();
  const teams = store.loadAllTeams();

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
  const awardsStr = buildAwards(participants, teams, sandbox.events);
  console.log(awardsStr);

  // 6. Winner Predictions
  console.log(subheader('WINNER PREDICTIONS'));
  const winnersStr = await buildWinnerPredictions(teams, participants, llm);
  console.log(winnersStr);

  // 7. The History
  console.log(subheader('THE HISTORY OF THE HACKATHON'));
  try {
    const { system, user } = buildHistoryPrompt(timelineStr, teamStr, dramaStr, winnersStr);
    const history = await llm.generate(system, user);
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

  console.log(header('REPORT SAVED TO data/analysis/'));
}
