# nanoSociety - civilizational research platform

Inspired by

1. Andrej Karpathy's `autoresearch` and `nanoGPT`
2. Irvis Janis - prof. at Yale & Berkley - he coined the term 'groupthink'
3. my research with Self-replicating Neural Networks

**nanoSociety**, is a radically minimalist agentic pipeline for civilizational research. It strips away bloated abstractions to focus purely on the emergent behavior of a self-improving population.

> "What happens if a billionaire wealth tax is introduced? nanoSociety is a first-principles testing harness to find out."

## The Core Mechanic: Self-Improving AI Beings

There are two types of entities: **Individual Beings** and **Collective Beings**.
Abstractions at the prompt level: countries & their state

### Individuals

An autonomous, self-improving AI being with:

1. **A Lifetime Goal** (e.g., "Become the wealthiest person in the city", "Survive in the wilderness")
2. **Stats** (`health_index`, `wealth_index`, `vibe_index`)
3. **An Identity Prompt** (`identity_md`): The core system prompt that dictates how the entity behaves

Future work:

- Individuals can start to belong to a collective, if they chose so, but then their individual desire is overwritten and not simulated anymore. They can also choose to separate.

### Collectives

A collective is itself a singular entity — it has its own `identity_md`, its own consensus goal at the expense of critical evaluation, especially under cohesion pressure. But it does not act through a body; it acts through **groupthink**.

When a collective's action turn fires, the `identity_md` produces a **groupthink decision**. The group decision overrides individual action for that tick — members act in concert. During self-eval, the collective evaluates whether the group action advanced the collective goal,

Future work

- members individually evaluate whether participating in the group helped or hurt their personal goal. This creates natural tension: an individual may leave a collective if group think consistently harms their personal stats, or join one if solo survival is failing. Joining and leaving is an action the individual can choose.

**The "Autoresearch" Loop:**
Each hearbeat is one day.

Every **7 simulation days**, an entity triggers a **self-evaluation** — not an external judge, but the agent itself reasoning about the causal chain:

> _"My `identity_md` made me choose action X. Did action X lead to the outcome I expected? If not, why?"_

The agent traces **identity → action → outcome** across its recent history, including delayed consequences (an investment made on day 2 may only pay off by day 14). From this, the agent extracts **world learnings** — empirical observations about how the simulation works (e.g., "trading with Entity 7B is unreliable", "farming yields more than foraging in this region", "health decays faster when traveling"). These learnings are persisted in a `world_knowledge` section of the agent's state and fed back into future action generation.

Based on this self-eval, the agent proposes **incremental adjustments** to its `identity_md` — **no major rewrites are allowed**. Changes must be small, targeted tweaks (shifting a priority, adding a tactic, incorporating a world learning) rather than wholesale personality replacements. All previous versions of `identity_md` are stored and versioned so the researcher can diff and compare the evolution of any entity over time. Only the latest version is used for the next simulation cycle.

---

## Architecture & The 4-Step Pipeline

No db. Use the filesystem as memory.

### 1. The Headless Simulation Engine (The Orchestrator)

A bare-minimum, dependency-light Node.js script (`nanosociety.ts`) that runs the continuous game loop.

- **The Heartbeat:** Every tick, survival pressure is applied. **Decay rates for `health_index`, `wealth_index`, and `vibe_index` are not global constants** — each agent's actions determine its own decay profile. An agent who works a stable job has low wealth decay; one who fights has high health decay. The LLM action response includes decay modifiers per stat.
- **The Action Generator:** For **individuals**, their current `identity_md`, stats, and goal are passed to the configured LLM to generate their next action, decay modifiers, and spatial coordinates. For **collectives**, all member `identity_md`s plus the collective's `identity_md` are passed in a single call to produce a group decision that members execute in concert. Individuals may also choose to join or leave collectives as an action. **The LLM provider is plug-and-play** — a single adapter interface (`LLMProvider`) lets you swap between models (Gemini, GPT, Claude, Llama, etc.) via config so you can run identical scenarios across providers and compare emergent behavior.
- **The Reflection & Mutation Skill:** Every **7 simulation days**, entities evaluate their progress. If failing, an LLM call proposes **incremental** changes to the `identity_md` (no major rewrites). The previous version is archived before the update.

### 2. The Mapbox Observer (The Frontend)

A stark, terminal-chic Next.js/React frontend built on Mapbox GL.

- **The Sandbox:** The entire world is mapped. Entities move across the globe as their actions execute.
- **The Terminal Sidebar:** A live, streaming feed of the entities' internal thoughts.
  - _Example:_ `[Tick 45] Entity 4A2 evaluated trajectory: FAILED.` $\rightarrow$ `Entity 4A2 overwrote identity_md from 'Carefree Artist' to 'Ruthless Capitalist'.`

### 3. The Perturbation Injector (The "Why")

The tool that makes this a "Civilizational Research Platform."

- A command-line or UI input allows the researcher to inject a massive systemic change: _"Introduce a 90% wealth tax on the top 1%"_ or _"A plague reduces all health by 50%."_
- **The Outcome:** The researcher watches in real-time as the entities scramble, fail, and autonomously rewrite their identities to adapt to the new reality.

---

## Implementation Steps for the Hackathon

### Phase 1: Filesystem Layout & Engine

- [ ] Initialize a fresh Node/TypeScript repository.
- [ ] Define the filesystem convention — all state lives under a `data/` root:
  - `data/sandbox.json` — world state (current tick, global params, active perturbations).
  - `data/beings/<id>/state.json` — per-entity state (`identity_md`, `goal`, `stats`, `coords`, `decay_rates`, `world_knowledge`, `type`, `memberships[]`, `members[]`).
  - `data/beings/<id>/identity_versions/<tick>.md` — archived `identity_md` snapshots, one file per mutation tick.
  - `data/beings/<id>/logs/` — append-only JSONL action log files (one line per tick action).
- [ ] Implement `LLMProvider` adapter interface and at least two concrete providers (e.g., Gemini, OpenAI) selectable via environment config.
- [ ] Write `nanosociety.ts`: The central orchestration loop handling the Heartbeat and LLM action generation. All reads/writes go through a thin `Store` module that wraps `fs` operations with JSON serialization.

### Phase 2: The Self-Improvement Loop

- [ ] Write the **Self-Eval Prompt**: The agent receives its own `identity_md`, its action log for the past 7 days, and the resulting stat changes. It must reason through the causal chain (`identity_md` → action → outcome) and answer: _did my identity lead me to actions that moved me toward my goal?_ It must also extract **world learnings** — things it now knows about the simulation that it didn't before.
- [ ] Write the **Mutation Prompt**: Based on the self-eval output (not a binary pass/fail — a reasoned assessment with learnings), propose **incremental** edits to the `identity_md`. The prompt must enforce a "no major changes" constraint — small tactical shifts only, informed by world learnings.
- [ ] Implement `identity_md` versioning: before mutation, copy the current `identity_md` to `data/beings/<id>/identity_versions/<tick>.md`. Expose a diff utility that reads two version files and returns the delta.

### Phase 3: The Mapbox UI

- [ ] Setup a Next.js frontend with Mapbox GL.
- [ ] Fetch entity coordinates and render them as live markers.
- [ ] Build the "Terminal Sidebar" that reads log files from `data/beings/*/logs/` and streams identity mutations in real-time (poll via API route that reads the filesystem).

### Phase 4: The Injector & Demo Polish

- [ ] Build a simple API route to accept a "Perturbation Prompt".
- [ ] Write the **Perturbation Skill**: An LLM agent that translates the user's natural language prompt into a batch of filesystem mutations — reading all `state.json` files, computing the changes (e.g., slashing wealth, altering world lore), and writing them back.
- [ ] Polish the UI to ensure the "wow factor" when a perturbation hits and the map erupts with activity.
