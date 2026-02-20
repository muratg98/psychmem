# PsychMem

**Psychology-grounded selective memory for AI coding agents**

PsychMem gives AI agents (Claude Code, OpenCode) human-like memory that persists across sessions. Instead of treating all context equally, it implements cognitive science principles: important information consolidates into long-term memory while trivial details decay away.

## Table of Contents

- [Why PsychMem?](#why-psychmem)
- [Psychological Foundations](#psychological-foundations)
- [How It Works](#how-it-works)
- [Mathematical Model](#mathematical-model)
- [Implementation Details](#implementation-details)
- [Installation](#installation)
- [Configuration](#configuration)
- [Architecture](#architecture)
- [Research References](#research-references)

---

## Why PsychMem?

Current AI agents have no persistent memory between sessions. Every conversation starts fresh, requiring users to re-explain preferences, project context, and past decisions. PsychMem solves this by:

1. **Extracting** important information from conversations in real-time
2. **Scoring** memories using psychology-based importance metrics
3. **Consolidating** significant memories to long-term storage
4. **Decaying** irrelevant memories using Ebbinghaus forgetting curves
5. **Injecting** relevant memories into new sessions automatically

---

## Psychological Foundations

PsychMem is built on established cognitive science research:

### Dual-Store Memory Model (Atkinson & Shiffrin, 1968)

Human memory operates in two stages:

- **Short-Term Memory (STM)**: Limited capacity (~4 items), rapid decay, holds task-relevant information
- **Long-Term Memory (LTM)**: Unlimited capacity, slow decay, consolidated through rehearsal/importance

PsychMem implements this with separate STM/LTM stores and different decay rates:
- STM decay rate: `λ = 0.05` (fast - memories lose ~5% strength per hour, ~32h half-life)
- LTM decay rate: `λ = 0.01` (slow - memories lose ~1% strength per hour)

### Working Memory Capacity (Cowan, 2001)

Research shows humans can hold **4 ± 1 items** in working memory simultaneously. PsychMem uses a slightly higher limit based on Miller's 7±2:

```typescript
maxMemoriesPerStop: 7  // Extract at most 7 memories per conversation turn
```

This prevents memory bloat while ensuring the most important information is captured.

### Forgetting Curve (Ebbinghaus, 1885)

Memory strength decays exponentially over time without reinforcement:

```
S(t) = S₀ × e^(-λt)
```

Where:
- `S(t)` = memory strength at time t
- `S₀` = initial strength
- `λ` = decay rate constant
- `t` = time elapsed (hours)

### Memory Reconsolidation (Nader et al., 2000)

When memories are retrieved and new conflicting information is presented, the memory becomes labile and can be updated. PsychMem implements this:

- **Reinforcing evidence** (similarity > 0.7): Boosts confidence, increments frequency
- **Conflicting evidence** (similarity < 0.3): Triggers reconsolidation, adjusts confidence
- **Neutral evidence**: No update needed

### Emotional Salience & Importance

Emotionally significant events are remembered better. PsychMem detects "emotional" signals in technical context:
- Errors and bugs (frustration/urgency)
- Corrections and mistakes (self-reflection)
- Explicit emphasis (ALL CAPS, "always", "never")
- Repeated requests (importance through frequency)

---

## How It Works

### Two-Stage Pipeline

```
┌─────────────────────────────────────────────────────────────────┐
│                     STAGE 1: CONTEXT SWEEP                       │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐       │
│  │  Multilingual │───▶│  Structural  │───▶│  Candidate   │       │
│  │   Patterns    │    │   Analysis   │    │  Extraction  │       │
│  │  (15 langs)   │    │ (typography) │    │              │       │
│  └──────────────┘    └──────────────┘    └──────────────┘       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                   STAGE 2: SELECTIVE MEMORY                      │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐       │
│  │   Feature    │───▶│   Strength   │───▶│    Store     │       │
│  │   Scoring    │    │  Calculation │    │  Allocation  │       │
│  │  (7 factors) │    │              │    │  (STM/LTM)   │       │
│  └──────────────┘    └──────────────┘    └──────────────┘       │
└─────────────────────────────────────────────────────────────────┘
```

### Stage 1: Context Sweep

Extracts memory candidates by detecting importance signals:

**Layer 1 - Multilingual Keyword Patterns (15 languages)**

| Signal Type | Examples | Weight |
|-------------|----------|--------|
| Explicit Remember | "remember this", "忘れないで", "не забудь" | 0.9 |
| Emphasis Cue | "always", "必ず", "никогда" | 0.8 |
| Bug/Fix | "error", "バグ", "ошибка" | 0.8 |
| Learning | "learned", "分かった", "узнал" | 0.8 |
| Correction | "actually", "実は", "на самом деле" | 0.7 |
| Decision | "decided", "決めた", "решил" | 0.7 |
| Constraint | "can't", "できない", "нельзя" | 0.7 |
| Preference | "prefer", "好き", "предпочитаю" | 0.6 |

Languages supported: English, Spanish, French, German, Portuguese, Japanese, Chinese (Simplified/Traditional), Korean, Russian, Arabic, Hindi, Italian, Dutch, Turkish, Polish

**Layer 2 - Structural Analysis (Language-Agnostic)**

| Signal Type | Detection Method | Weight |
|-------------|------------------|--------|
| Typography Emphasis | ALL CAPS, `!!`, bold markdown | 0.7 |
| Correction Pattern | Short reply after long message | 0.6 |
| Repetition | Trigram overlap > 40% | 0.7 |
| Elaboration | Reply > 2× median length | 0.5 |
| Enumeration | Lists, "first/then/finally" | 0.5 |
| Meta Reference | Near tool errors, stack traces | 0.6 |

### Stage 2: Selective Memory

Scores candidates and allocates to appropriate store:

**7-Feature Scoring Model**

```
Strength = Σ(wᵢ × fᵢ)
```

| Feature | Weight | Description |
|---------|--------|-------------|
| Recency | 0.20 | Time since creation (inverted, week scale) |
| Frequency | 0.15 | Access count (log-normalized) |
| Importance | 0.25 | Explicit + inferred signals |
| Utility | 0.20 | Task usefulness (feedback-adjusted) |
| Novelty | 0.10 | Distinctiveness vs existing memories |
| Confidence | 0.10 | Evidence consensus |
| Interference | -0.10 | Conflict penalty (negative weight) |

**Store Allocation Rules**

| Classification | Default Store | Auto-Promote | Scope |
|----------------|---------------|--------------|-------|
| bugfix | LTM | Yes | Project |
| learning | LTM | Yes | User |
| decision | LTM | Yes | Project |
| constraint | STM | No | User |
| preference | STM | No | User |
| procedural | STM | No | User |
| semantic | STM | No | Project |
| episodic | STM | No | Project |

**Consolidation (STM → LTM)**

Memories promote to LTM when any condition is met:
- Strength ≥ 0.7 (high importance)
- Frequency ≥ 3 (repeated access/mention)
- Classification is auto-promote type

---

## Mathematical Model

### Memory Strength Calculation

```typescript
function calculateStrength(features: MemoryFeatureVector): number {
  const w = scoringWeights;
  
  // Normalize frequency (log scale for diminishing returns)
  const normalizedFrequency = Math.min(1, Math.log(frequency + 1) / Math.log(10));
  
  // Recency factor (0 = now, 1 = old; 168 hours = 1 week)
  const recencyFactor = 1 - Math.min(1, recency / 168);
  
  const strength =
    w.recency * recencyFactor +
    w.frequency * normalizedFrequency +
    w.importance * importance +
    w.utility * utility +
    w.novelty * novelty +
    w.confidence * confidence +
    w.interference * interference;  // Negative contribution

  return clamp(strength, 0, 1);
}
```

### Exponential Decay Application

```typescript
function applyDecay(): void {
  for (const memory of activeMemories) {
    const dtHours = (now - memory.updatedAt) / (1000 * 60 * 60);
    const newStrength = memory.strength * Math.exp(-memory.decayRate * dtHours);
    
    if (newStrength < 0.1) {
      memory.status = 'decayed';  // Below threshold, mark for removal
    } else {
      memory.strength = newStrength;
    }
  }
}
```

### Preliminary Importance (Signal Combination)

```typescript
function calculatePreliminaryImportance(signals: ImportanceSignal[]): number {
  // Sort by weight (strongest first)
  const sorted = signals.sort((a, b) => b.weight - a.weight);
  
  // Combine with diminishing returns
  let importance = 0;
  for (let i = 0; i < sorted.length; i++) {
    importance += sorted[i].weight * Math.pow(0.7, i);  // Each signal contributes 70% of previous
  }
  
  return Math.min(1, importance);
}
```

### Novelty Calculation (Inverse Similarity)

```typescript
function calculateNovelty(candidate: MemoryCandidate): number {
  const existingMemories = getTopMemories(50);
  
  if (existingMemories.length === 0) return 1.0;  // Everything is novel initially
  
  // Find max similarity to any existing memory
  let maxSimilarity = 0;
  for (const mem of existingMemories) {
    const similarity = jaccardSimilarity(candidate.summary, mem.summary);
    maxSimilarity = Math.max(maxSimilarity, similarity);
  }
  
  return 1 - maxSimilarity;  // Novelty is inverse of similarity
}
```

### Interference Detection

```typescript
function detectInterference(candidate: MemoryCandidate): number {
  let interference = 0;
  
  for (const mem of existingMemories) {
    const similarity = jaccardSimilarity(candidate.summary, mem.summary);
    
    // Similar topic (0.3-0.8) but different content = potential conflict
    if (similarity > 0.3 && similarity < 0.8) {
      interference = Math.max(interference, similarity * 0.5);
    }
  }
  
  return interference;
}
```

### Text Similarity (Jaccard Index)

```typescript
function jaccardSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/));
  const wordsB = new Set(b.toLowerCase().split(/\s+/));
  
  const intersection = new Set([...wordsA].filter(x => wordsB.has(x)));
  const union = new Set([...wordsA, ...wordsB]);
  
  return intersection.size / union.size;
}
```

---

## Implementation Details

### Deduplication Strategy

Before storing, candidates are deduplicated using **70% keyword overlap threshold**:

```typescript
deduplicationThreshold: 0.7  // If 70%+ words match, merge candidates
```

This prevents storing "User prefers TypeScript" and "User prefers using TypeScript" as separate memories.

### Memory Scoping (v1.6)

Memories are scoped to prevent project-specific knowledge from polluting unrelated sessions:

**User-Level** (always injected):
- Constraints: "Never use `var` in TypeScript"
- Preferences: "Prefers functional style"
- Learnings: "Learned that bun:sqlite has different API"
- Procedural: "Run tests before committing"

**Project-Level** (only injected for matching project):
- Decisions: "Decided to use SQLite over Postgres"
- Bugfixes: "Fixed null pointer in auth module"
- Semantic: "The API uses REST, not GraphQL"
- Episodic: "Yesterday we refactored the auth flow"

### Per-Message Extraction (v1.9)

Instead of waiting for session end, PsychMem extracts memories after each message:

```typescript
// Sliding window approach
messageWindowSize: 3       // Include last 3 messages for context
messageImportanceThreshold: 0.5  // Only extract if importance >= 0.5
```

**Pre-filter for efficiency**: Before running full extraction, a lightweight regex check skips low-signal messages:

```typescript
function preFilterImportance(content: string): boolean {
  // Quick check for high-importance patterns
  return /remember|important|always|never|error|bug|fix|learned|decided/i.test(content);
}
```

### Confidence Levels

Different extraction methods yield different confidence:

| Method | Confidence | Rationale |
|--------|------------|-----------|
| Multilingual regex match | 0.75 | Explicit language patterns are reliable |
| Structural analysis only | 0.50 | Typography/flow signals are suggestive |
| Tool event analysis | 0.60 | Errors/fixes are usually important |
| Repetition detection | 0.50 | Frequency suggests importance |

### Runtime Compatibility

PsychMem works in both:
- **Node.js** (Claude Code CLI): Uses `better-sqlite3`
- **Bun** (OpenCode plugins): Uses `bun:sqlite`

The `sqlite-adapter.ts` abstracts the differences:

```typescript
export async function createDatabase(dbPath: string): Promise<SqliteDatabase> {
  if (isBun()) {
    const { Database } = await import('bun:sqlite');
    return new Database(dbPath);
  } else {
    const Database = (await import('better-sqlite3')).default;
    return new Database(dbPath);
  }
}
```

---

## Installation

### Prerequisites

PsychMem uses `better-sqlite3` which requires native compilation. Ensure you have:

- **Windows**: [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with "Desktop development with C++" workload, and Python 3.x
- **macOS**: Xcode Command Line Tools (`xcode-select --install`)
- **Linux**: `build-essential` package (`sudo apt install build-essential`)

### OpenCode Plugin

OpenCode auto-loads any `.ts` or `.js` files placed in its plugin directories — **no `opencode.json` changes needed**. The `plugin` key in `opencode.json` is only for published npm packages.

**Option 1: Global (works in every project) — Linux/macOS:**
```bash
# Clone the repo into the global plugin directory
git clone https://github.com/muratg98/psychmem.git ~/.config/opencode/plugins/psychmem
cd ~/.config/opencode/plugins/psychmem
npm install && npm run build

# Symlink the plugin entry point into the auto-load directory
ln -s ~/.config/opencode/plugins/psychmem/.opencode/plugins/psychmem.ts \
      ~/.config/opencode/plugins/psychmem.ts
```

**Option 1: Global — Windows (PowerShell):**
```powershell
# Clone the repo
git clone https://github.com/muratg98/psychmem.git "$env:USERPROFILE\.config\opencode\plugins\psychmem"
cd "$env:USERPROFILE\.config\opencode\plugins\psychmem"
npm install && npm run build

# Copy the plugin entry point into the auto-load directory
Copy-Item ".opencode\plugins\psychmem.ts" "$env:USERPROFILE\.config\opencode\plugins\psychmem.ts"
```

> **Note (Windows):** The plugin imports from a relative `../../dist/` path. After copying, edit the copied `psychmem.ts` and replace the `../../dist/` imports with the absolute path to the `dist/` folder, e.g. `C:/Users/<YourUsername>/.config/opencode/plugins/psychmem/dist/`.

**Option 2: Project-local (only active in one project):**
```bash
# Clone directly into your project's plugin auto-load directory
git clone https://github.com/muratg98/psychmem.git .opencode/plugins/psychmem
cd .opencode/plugins/psychmem
npm install && npm run build

# Symlink (or copy) the entry point up one level so OpenCode picks it up
ln -s .opencode/plugins/psychmem/.opencode/plugins/psychmem.ts \
      .opencode/plugins/psychmem.ts
```

OpenCode will automatically load any `.ts` file in `.opencode/plugins/` at startup — no config entry required.

> **Do not add `"plugin": ["psychmem"]` to `opencode.json`** — that tells OpenCode to fetch `psychmem` from npm, which will fail with a `BunInstallFailedError` until the package is published.

### Claude Code Integration

PsychMem integrates with Claude Code via the hooks system.

**Linux/macOS:**
```bash
# Clone to Claude Code's plugins directory
git clone https://github.com/muratg98/psychmem.git ~/.claude/plugins/psychmem

# Install and build
cd ~/.claude/plugins/psychmem
npm install
npm run build
```

**Windows (PowerShell):**
```powershell
# Clone to Claude Code's plugins directory
git clone https://github.com/muratg98/psychmem.git "$env:USERPROFILE\.claude\plugins\psychmem"

# Install and build
cd "$env:USERPROFILE\.claude\plugins\psychmem"
npm install
npm run build
```

Then register the hooks in your Claude Code settings (`~/.claude/settings.json`):

```json
{
  "plugins": [
    {
      "name": "psychmem",
      "root": "~/.claude/plugins/psychmem",
      "hooks": "hooks/hooks.json"
    }
  ]
}
```

PsychMem will then automatically:
- **Inject** relevant memories at session start
- **Track** tool usage during the session (async, non-blocking)
- **Extract** memories when you stop or end a session

Memories are written to Claude Code's auto-loaded memory location:
- `~/.claude/projects/<project>/memory/MEMORY.md` (first 200 lines auto-loaded)
- Topic files: `constraints.md`, `learnings.md`, `decisions.md`, `bugfixes.md`

---

## Configuration

### Environment Variables

```bash
# Core settings
PSYCHMEM_AGENT_TYPE=opencode              # or "claude-code"
PSYCHMEM_DB_PATH=~/.psychmem/{agentType}/memory.db

# OpenCode-specific
PSYCHMEM_INJECT_ON_COMPACTION=true        # Inject memories during compaction
PSYCHMEM_EXTRACT_ON_COMPACTION=true       # Extract before compaction
PSYCHMEM_EXTRACT_ON_MESSAGE=true          # Per-message extraction
PSYCHMEM_MAX_COMPACTION_MEMORIES=10       # Max memories on compaction
PSYCHMEM_MAX_SESSION_MEMORIES=10          # Max memories on session start
PSYCHMEM_MESSAGE_WINDOW_SIZE=3            # Messages for context window
PSYCHMEM_MESSAGE_IMPORTANCE_THRESHOLD=0.5 # Min importance for extraction
```

### Default Configuration

```typescript
const DEFAULT_CONFIG: PsychMemConfig = {
  // Decay rates (per hour)
  stmDecayRate: 0.05,     // ~32-hour half-life
  ltmDecayRate: 0.01,     // Slow decay for LTM
  
  // Consolidation thresholds
  stmToLtmStrengthThreshold: 0.7,
  stmToLtmFrequencyThreshold: 3,
  
  // Scoring weights (sum to ~1.0)
  scoringWeights: {
    recency: 0.20,
    frequency: 0.15,
    importance: 0.25,
    utility: 0.20,
    novelty: 0.10,
    confidence: 0.10,
    interference: -0.10,
  },
  
  // Working memory limit (Miller's 7±2)
  maxMemoriesPerStop: 7,
  
  // Deduplication
  deduplicationThreshold: 0.7,
  
  // Auto-promote to LTM
  autoPromoteToLtm: ['bugfix', 'learning', 'decision'],
};
```

---

## Architecture

```
src/
├── index.ts                    # Main PsychMem class
├── types/index.ts              # TypeScript definitions, config
├── storage/
│   ├── database.ts             # SQLite storage with decay
│   └── sqlite-adapter.ts       # Node.js/Bun compatibility
├── memory/
│   ├── context-sweep.ts        # Stage 1: Extract candidates
│   ├── selective-memory.ts     # Stage 2: Score & consolidate
│   ├── patterns.ts             # Multilingual importance patterns
│   └── structural-analyzer.ts  # Typography/flow signals
├── hooks/
│   └── stop.ts                 # Main extraction hook
├── retrieval/
│   └── index.ts                # Scope-aware retrieval
├── adapters/
│   ├── opencode/index.ts       # OpenCode plugin adapter
│   └── claude-code/index.ts    # Claude Code auto-memory adapter
└── transcript/
    └── sweep.ts                # Transcript-based extraction
```

### Data Storage

```
~/.psychmem/
├── opencode/memory.db          # OpenCode memories
└── claude-code/memory.db       # Claude Code memories

# Claude Code also uses:
~/.claude/projects/<project>/memory/
├── MEMORY.md                   # Main file (first 200 lines loaded)
├── constraints.md
├── learnings.md
├── decisions.md
└── bugfixes.md
```

---

## Research References

### Primary Sources

1. **Atkinson, R.C. & Shiffrin, R.M.** (1968). Human memory: A proposed system and its control processes. *Psychology of Learning and Motivation*, 2, 89-195.
   - Foundation for dual-store (STM/LTM) memory model

2. **Ebbinghaus, H.** (1885). *Über das Gedächtnis: Untersuchungen zur experimentellen Psychologie*. Leipzig: Duncker & Humblot.
   - Original forgetting curve research: `R = e^(-t/S)`

3. **Cowan, N.** (2001). The magical number 4 in short-term memory: A reconsideration of mental storage capacity. *Behavioral and Brain Sciences*, 24(1), 87-114.
   - Working memory capacity of 4±1 items

4. **Nader, K., Schafe, G.E., & LeDoux, J.E.** (2000). Fear memories require protein synthesis in the amygdala for reconsolidation after retrieval. *Nature*, 406(6797), 722-726.
   - Memory reconsolidation theory

### Supporting Research

5. **Baddeley, A.D. & Hitch, G.** (1974). Working memory. *Psychology of Learning and Motivation*, 8, 47-89.
   - Working memory model and capacity limits

6. **McGaugh, J.L.** (2000). Memory—a century of consolidation. *Science*, 287(5451), 248-251.
   - Memory consolidation mechanisms

7. **Roediger, H.L. & Karpicke, J.D.** (2006). The power of testing memory: Basic research and implications for educational practice. *Perspectives on Psychological Science*, 1(3), 181-210.
   - Spaced repetition and retrieval practice (basis for frequency-based promotion)

8. **Craik, F.I.M. & Lockhart, R.S.** (1972). Levels of processing: A framework for memory research. *Journal of Verbal Learning and Verbal Behavior*, 11(6), 671-684.
   - Depth of processing affects memory strength (basis for importance weighting)

### Applied Cognitive Science

9. **Anderson, J.R. & Schooler, L.J.** (1991). Reflections of the environment in memory. *Psychological Science*, 2(6), 396-408.
   - Environmental statistics predict memory retrieval (basis for utility scoring)

10. **Wickens, D.D.** (1970). Encoding categories of words: An empirical approach to meaning. *Psychological Review*, 77(1), 1-15.
    - Interference effects in memory (basis for interference penalty)

---

## License

MIT

---

## Contributing

Contributions welcome! Key areas:
- Additional language patterns (currently 15 languages)
- Improved structural signal detection
- Learned scoring weights (currently rule-based)
- Integration with other AI agents

See [GitHub Issues](https://github.com/muratg98/psychmem/issues) for open tasks.
