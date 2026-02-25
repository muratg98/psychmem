# PsychMem

Psychology-grounded selective memory for AI coding agents.

PsychMem gives [OpenCode](https://opencode.ai) persistent, psychology-based memory that survives across sessions, context compaction, and restarts. It hooks into OpenCode's plugin system to automatically extract what matters from your conversations, store it with decay-aware scoring, and inject relevant context back at the start of every session — without you having to manage any of it manually.

Unlike simple note-taking or full-transcript approaches, PsychMem is selective by design: it scores each candidate memory across seven cognitive features, lets irrelevant details fade via Ebbinghaus decay curves, and caps extraction at Miller's Law limit (7 items per turn). The result is a memory store that grows smarter over time rather than just larger.

## Experimental

This plugin is under active development. The core memory system works — extraction, scoring, decay, consolidation, and injection across sessions — but comprehensive test coverage is still being built. Expect rough edges. See the [test plan](TEST_PLAN.md) for what's planned.

If you run into issues, please [open an issue](https://github.com/muratg98/psychmem/issues).

## Features

- **Persistent memory** — Information survives across sessions, context compaction, and restarts
- **Automatic extraction** — Detects important information from conversations in real-time (preferences, decisions, bugfixes, constraints)
- **Psychology-based decay** — Ebbinghaus forgetting curves let irrelevant memories fade naturally
- **STM/LTM consolidation** — Dual-store model with automatic promotion based on strength, frequency, and classification
- **Scope-aware injection** — User-level memories (preferences, constraints) always injected; project-level memories (decisions, bugfixes) only injected for the matching project
- **Multilingual** — Importance detection patterns in 15 languages

## Requirements

- [OpenCode](https://opencode.ai/) (latest)
- Node.js 22+ **or** Bun (for `node:sqlite` / `bun:sqlite`)

## Installation

### OpenCode (recommended)

OpenCode manages plugin installation automatically. Add `psychmem` to your config and OpenCode will fetch and cache it from npm via Bun on the next startup — no manual install required.

**Global** (`~/.config/opencode/opencode.json`) — memory works across all your projects:

```json
{
  "plugin": ["psychmem"]
}
```

**Per-project** (`opencode.json` in your project root) — memory scoped to this project only:

```json
{
  "plugin": ["psychmem"]
}
```

OpenCode caches packages in `~/.cache/opencode/node_modules/`. To pin to a specific version:

```json
{
  "plugin": ["psychmem@1.0.10"]
}
```

### npm / Bun (manual)

If you want to install psychmem outside of OpenCode's plugin system (e.g. to use the CLI or import the library):

```bash
# npm
npm install psychmem

# Bun
bun add psychmem
```

### Local Development

```bash
git clone https://github.com/muratg98/psychmem.git
cd psychmem
npm install && npm run build
```

To load a local build as an OpenCode plugin, place or symlink `plugin.js` into the plugin directory:

```bash
# Linux/macOS — global
ln -sf "$(pwd)/plugin.js" ~/.config/opencode/plugins/psychmem.js

# Linux/macOS — project-level
ln -sf "$(pwd)/plugin.js" .opencode/plugins/psychmem.js

# Windows (PowerShell) — copy instead
Copy-Item "plugin.js" "$env:USERPROFILE\.config\opencode\plugins\psychmem.js"
```

## How It Works

PsychMem is modeled on how human memory actually works, not on simple key-value storage or vector databases.

### The Psychology

Four core principles from cognitive science drive the design:

**1. Dual-Store Model** (Atkinson & Shiffrin, 1968)

Human memory has two stages. Short-term memory holds a few items briefly; long-term memory stores consolidated knowledge indefinitely. PsychMem mirrors this with separate STM and LTM stores, each with different decay rates:

- STM: `lambda = 0.05` (~32-hour half-life, fast decay)
- LTM: `lambda = 0.01` (slow decay, persists for weeks)

**2. Forgetting Curve** (Ebbinghaus, 1885)

Memory strength decays exponentially without reinforcement:

```
S(t) = S_0 * e^(-lambda * t)
```

Memories that aren't accessed or reinforced gradually fade. When strength drops below 0.1, the memory is marked as decayed. This prevents unbounded memory growth — only genuinely important things survive.

**3. Working Memory Limits** (Miller, 1956; Cowan, 2001)

Humans can hold roughly 7 (plus or minus 2) items in working memory. PsychMem caps extraction at 7 memories per conversation turn, forcing it to prioritize the most important information rather than hoarding everything.

**4. Reconsolidation** (Nader et al., 2000)

When a stored memory is retrieved alongside new conflicting information, the memory can be updated. PsychMem detects when new evidence reinforces (similarity > 0.7) or conflicts with (similarity < 0.3) existing memories and adjusts accordingly.

### The Pipeline

Memory extraction happens in two stages:

```
Conversation
    |
    v
+-- STAGE 1: Context Sweep --------------------------------+
|                                                           |
|  Multilingual Patterns (15 langs)                         |
|  "remember this", "always use...", "fixed the bug..."     |
|                                                           |
|  Structural Analysis (language-agnostic)                  |
|  ALL CAPS, short corrections, repeated requests,          |
|  code blocks, stack traces, enumerated lists              |
|                                                           |
+--------------------------|--------------------------------+
                           |
                           v
+-- STAGE 2: Selective Memory ------------------------------+
|                                                           |
|  7-Feature Scoring                                        |
|  recency, frequency, importance, utility,                 |
|  novelty, confidence, interference(-penalty)              |
|                                                           |
|  Deduplication (70% Jaccard overlap = merge)              |
|  Store Allocation (STM vs LTM)                            |
|  Miller's Law Cap (max 7 per turn)                        |
|                                                           |
+-----------------------------------------------------------+
    |
    v
  SQLite (persisted to ~/.psychmem/)
```

### The Math

**Strength scoring** — a weighted sum of 7 features:

| Feature | Weight | What it measures |
|---------|--------|-----------------|
| Recency | 0.20 | Time since creation (week scale, inverted) |
| Frequency | 0.15 | Access count (log-normalized for diminishing returns) |
| Importance | 0.25 | Explicit + inferred signals from extraction |
| Utility | 0.20 | Task usefulness (feedback-adjusted) |
| Novelty | 0.10 | Distinctiveness vs existing memories (Jaccard inverse) |
| Confidence | 0.10 | Evidence consensus from multiple sources |
| Interference | -0.10 | Conflict penalty — similar topic, different content |

**Consolidation** — memories promote from STM to LTM when any condition is met:
- Strength >= 0.7
- Frequency >= 3 (accessed/mentioned multiple times)
- Classification is auto-promote type (bugfix, learning, decision)

**Scoping** — memories are classified into 8 types with automatic scope assignment:

| Classification | Scope | Auto-Promote | Example |
|----------------|-------|--------------|---------|
| preference | User | No | "Always use tabs" |
| constraint | User | No | "Never use `var`" |
| learning | User | Yes | "Learned that bun:sqlite differs from node:sqlite" |
| procedural | User | No | "Run tests before committing" |
| decision | Project | Yes | "Chose SQLite over Postgres" |
| bugfix | Project | Yes | "Fixed null pointer in auth" |
| semantic | Project | No | "API uses REST, not GraphQL" |
| episodic | Project | No | "Refactored the auth flow yesterday" |

User-scoped memories are injected in every session. Project-scoped memories are only injected when working on the same project.

## Configuration

### Environment Variables

```bash
PSYCHMEM_INJECT_ON_COMPACTION=true         # Inject memories during context compaction
PSYCHMEM_EXTRACT_ON_COMPACTION=true        # Extract memories before compaction
PSYCHMEM_EXTRACT_ON_MESSAGE=true           # Per-message extraction (real-time)
PSYCHMEM_MAX_COMPACTION_MEMORIES=10        # Max memories injected on compaction
PSYCHMEM_MAX_SESSION_MEMORIES=10           # Max memories injected on session start
PSYCHMEM_MESSAGE_WINDOW_SIZE=3             # Recent messages for extraction context
PSYCHMEM_MESSAGE_IMPORTANCE_THRESHOLD=0.5  # Min importance to trigger extraction
```

### Data Storage

```
~/.psychmem/
  opencode/memory.db       # OpenCode memories (SQLite)
```

## Architecture

```
src/
  index.ts                    # Plugin entry (OpenCode — exports only plugin function)
  core.ts                     # Library API (all classes/factories re-exported)
  cli.ts                      # CLI for memory management
  types/index.ts              # Type definitions, config, constants
  storage/
    database.ts               # SQLite storage with decay, consolidation, scoping
    sqlite-adapter.ts         # Node.js / Bun runtime compatibility
  memory/
    context-sweep.ts          # Stage 1: Extract candidates from conversation
    selective-memory.ts       # Stage 2: Score, deduplicate, store
    patterns.ts               # Multilingual importance patterns (15 languages)
    structural-analyzer.ts    # Language-agnostic structural signals
  hooks/
    index.ts                  # Hook dispatcher
    session-start.ts          # Inject memories on session start
    stop.ts                   # Extract memories on stop
    session-end.ts            # Decay + consolidation on session end
    post-tool-use.ts          # Track tool usage
  retrieval/
    index.ts                  # Scope-aware memory search (Jaccard similarity)
  adapters/
    types.ts                  # Adapter interfaces, OpenCode SDK types
    opencode/index.ts         # OpenCode plugin (event, tool, chat, compaction hooks)
  utils/
    paths.ts                  # DB path resolution, directory creation
```

## Debugging

PsychMem includes a few utility commands for inspecting the memory database. These are development/debugging tools, not a primary interface:

```bash
npx psychmem stats                 # Show memory statistics
npx psychmem list                  # List active memories
npx psychmem search "error handling" # Search memories by text
```

Run `npx psychmem help` for the full list.

## Research References

1. **Atkinson, R.C. & Shiffrin, R.M.** (1968). Human memory: A proposed system and its control processes. *Psychology of Learning and Motivation*, 2, 89-195.
2. **Ebbinghaus, H.** (1885). *Uber das Gedachtnis*. Leipzig: Duncker & Humblot.
3. **Miller, G.A.** (1956). The magical number seven, plus or minus two. *Psychological Review*, 63(2), 81-97.
4. **Cowan, N.** (2001). The magical number 4 in short-term memory. *Behavioral and Brain Sciences*, 24(1), 87-114.
5. **Nader, K., Schafe, G.E., & LeDoux, J.E.** (2000). Fear memories require protein synthesis in the amygdala for reconsolidation after retrieval. *Nature*, 406(6797), 722-726.
6. **McGaugh, J.L.** (2000). Memory — a century of consolidation. *Science*, 287(5451), 248-251.
7. **Craik, F.I.M. & Lockhart, R.S.** (1972). Levels of processing: A framework for memory research. *Journal of Verbal Learning and Verbal Behavior*, 11(6), 671-684.
8. **Anderson, J.R. & Schooler, L.J.** (1991). Reflections of the environment in memory. *Psychological Science*, 2(6), 396-408.

## Contributing

Contributions welcome. Key areas where help is needed:

- **Test coverage** — see [TEST_PLAN.md](TEST_PLAN.md) for the full plan (~130 test cases across 20 files)
- **Additional language patterns** — currently 15 languages supported
- **Learned scoring weights** — currently rule-based, could train on feedback data
- **Integration with other agents** — Cursor, Windsurf, etc.

```bash
git clone https://github.com/muratg98/psychmem.git
cd psychmem
npm install && npm run build
npm test  # (once tests are implemented)
```

## License

MIT

---

PsychMem is not built by, or affiliated with, the OpenCode or Anthropic teams.
