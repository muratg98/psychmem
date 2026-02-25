# PsychMem Comprehensive Test Plan

> Generated: 2026-02-24
> Status: Approved, not yet implemented

## Approach

- **Framework:** `node:test` (already configured in `package.json` scripts)
- **Location:** `src/**/*.test.ts` files alongside source (compiles to `dist/**/*.test.js`, matches existing `npm test` glob)
- **Isolation:** Each test file creates its own in-memory or temp-file SQLite database. No shared state.
- **No mocks needed** for most tests — the core is pure logic over SQLite. Adapter tests may need lightweight stubs.

---

## Test Files & Coverage Map

### 1. `src/types/index.test.ts` — Type helpers & constants

| Test | What it verifies |
|------|-----------------|
| `isUserLevelClassification()` returns true for constraint, preference, learning, procedural | Correct user-level set |
| `isUserLevelClassification()` returns false for decision, bugfix, episodic, semantic | Correct project-level set |
| `getScopeForClassification()` returns `'user'` vs `'project'` correctly | Scope mapping |
| `USER_LEVEL_CLASSIFICATIONS` and `PROJECT_LEVEL_CLASSIFICATIONS` are disjoint and cover all 8 types | Exhaustive coverage |
| `DEFAULT_CONFIG` has valid scoring weights that sum reasonably | Config sanity |
| `DEFAULT_CONFIG.scoringWeights.interference` is negative | Penalty weight check |

### 2. `src/storage/sqlite-adapter.test.ts` — SQLite adapter

| Test | What it verifies |
|------|-----------------|
| `createDatabase()` creates a working database | Basic connectivity |
| `isBun()` returns boolean | Runtime detection |
| Database supports `exec()`, `prepare()`, `close()` | Interface contract |
| Statement supports `run()`, `get()`, `all()` | Statement contract |
| `run()` returns `{ changes, lastInsertRowid }` | Return shape |

### 3. `src/storage/database.test.ts` — MemoryDatabase (largest test file)

**Lifecycle:**

| Test | What it verifies |
|------|-----------------|
| `createMemoryDatabase()` factory returns initialized instance | Factory pattern |
| Methods throw before `init()` | Pre-init guard |
| `close()` works without error | Cleanup |
| Schema version mismatch throws descriptive error | Migration guard |

**Sessions:**

| Test | What it verifies |
|------|-----------------|
| `createSession()` returns valid Session with UUID, timestamps, status='active' | Session creation |
| `getSession()` returns session by ID | Session retrieval |
| `getSession()` returns null for unknown ID | Missing session |
| `endSession()` sets status and endedAt | Session completion |
| `endSession('abandoned')` sets correct status | Abandon path |
| `getActiveSessions()` returns only active sessions | Active filter |
| `getSessionWatermark()` returns 0 for new session | Default watermark |
| `updateSessionWatermark()` / `getSessionWatermark()` round-trips | Watermark persistence |
| `getMessageWatermark()` / `updateMessageWatermark()` round-trips | Message watermark |

**Events:**

| Test | What it verifies |
|------|-----------------|
| `createEvent()` stores and returns valid Event | Event creation |
| `getSessionEvents()` returns events in timestamp order | Ordering |
| `getRecentEvents()` returns events in reverse order, respects limit | Recency + limit |
| `createEvent()` with optional toolName/toolInput/toolOutput | Optional fields |

**Memory CRUD:**

| Test | What it verifies |
|------|-----------------|
| `createMemory()` returns valid MemoryUnit with computed strength | Memory creation |
| `createMemory()` with STM store uses stmDecayRate | Decay rate selection |
| `createMemory()` with LTM store uses ltmDecayRate | Decay rate selection |
| `createMemory()` with no features defaults to 0.5 | Default scoring |
| `getMemory()` retrieves by ID | Single retrieval |
| `getMemory()` returns null for unknown ID | Missing memory |
| `getMemoriesByStore('stm')` filters correctly | Store filter |
| `getMemoriesByStore('ltm')` filters correctly | Store filter |
| `getTopMemories()` respects limit and orders by strength | Top-N |
| `updateMemoryStrength()` persists new strength | Strength update |
| `updateMemoryStatus()` changes status | Status lifecycle |
| `incrementFrequency()` increments by 1 and updates lastAccessedAt | Frequency tracking |
| `promoteToLtm()` changes store and decay rate | STM->LTM promotion |

**Scoping:**

| Test | What it verifies |
|------|-----------------|
| `getMemoriesByScope(projectA)` returns user-level + projectA memories | Scope filtering |
| `getMemoriesByScope(projectA)` does NOT return projectB memories | Cross-project isolation |
| `getMemoriesByScope(undefined)` returns user-level memories only | Undefined project |
| `getUserLevelMemories()` only returns constraint/preference/learning/procedural | Classification filter |
| `getProjectMemories(project)` only returns that project's memories | Project filter |
| `getSessionMemories()` returns memories from specific session | Session scoping |

**Feedback:**

| Test | What it verifies |
|------|-----------------|
| `addFeedback('pin', memoryId)` sets status to 'pinned' | Pin side effect |
| `addFeedback('forget', memoryId)` sets status to 'forgotten' | Forget side effect |
| `addFeedback('remember', memoryId)` boosts importance +0.3, promotes to LTM | Remember side effect |
| `addFeedback('remember', memoryId)` caps importance at 1.0 | Cap check |
| `addFeedback('correct', memoryId)` stores feedback | Correct feedback |

**Retrieval Logs:**

| Test | What it verifies |
|------|-----------------|
| `logRetrieval()` returns log ID | Log creation |
| `markRetrievalUsed()` updates wasUsed | Usage tracking |
| `addRetrievalFeedback()` stores feedback | Feedback storage |

**Transactions:**

| Test | What it verifies |
|------|-----------------|
| `beginTransaction()` + `commitTransaction()` persists changes | Commit path |
| `beginTransaction()` + `rollbackTransaction()` discards changes | Rollback path |
| Nested `beginTransaction()` is a no-op | Re-entrance guard |

**Decay & Consolidation:**

| Test | What it verifies |
|------|-----------------|
| `applyDecay()` reduces strength of active memories | Decay application |
| `applyDecay()` marks memories below 0.1 as 'decayed' | Threshold behavior |
| `applyDecay()` skips pinned/forgotten/decayed memories | Status filtering |
| `applyDecay()` returns count of decayed memories | Return value |
| `runConsolidation()` promotes STM memories meeting strength threshold | Strength promotion |
| `runConsolidation()` promotes STM memories meeting frequency threshold | Frequency promotion |
| `runConsolidation()` promotes auto-promote classifications (bugfix, learning, decision) | Auto-promote |
| `runConsolidation()` returns count promoted | Return value |
| `calculateStrength()` returns value in [0, 1] | Bounds check |
| `calculateStrength()` with all zeros returns 0 | Floor check |
| `calculateStrength()` interference reduces score | Penalty effect |

### 4. `src/utils/paths.test.ts` — Path utilities

| Test | What it verifies |
|------|-----------------|
| `resolveDbPath()` replaces `{agentType}` template | Template expansion |
| `resolveDbPath()` expands `~` to homedir | Home expansion |
| `resolveDbPath()` creates parent directory | Directory creation |
| `getDataDir()` returns correct path per agent type | Agent routing |
| `getDefaultDbPath()` returns expected path | Default path |

### 5. `src/memory/patterns.test.ts` — Multilingual regex patterns

| Test | What it verifies |
|------|-----------------|
| `matchAllPatterns()` detects "remember this" as `explicit_remember` | English keyword |
| `matchAllPatterns()` detects "always use tabs" as `emphasis_cue` + `preference` | Multi-signal |
| `matchAllPatterns()` detects "no, use X instead" as `correction` | Correction pattern |
| `matchAllPatterns()` detects "fixed the bug" as `bug_fix` | Bugfix detection |
| `matchAllPatterns()` returns empty for neutral text | No false positives |
| `classifyByPatterns()` returns correct MemoryClassification | Classification mapping |

### 6. `src/memory/structural-analyzer.test.ts` — Structural analysis

| Test | What it verifies |
|------|-----------------|
| Typography: ALL CAPS detected as `typography_emphasis` | Caps detection |
| Typography: `!!!` detected as emphasis | Exclamation detection |
| Correction pattern: short reply after long reply | Flow analysis |
| Repetition pattern: >60% trigram overlap | Repetition detection |
| Elaboration: reply >2x median length | Length analysis |
| Enumeration: ordered lists / arrows | Structure detection |
| Meta-reference: file paths, stack traces | Technical markers |
| Quoted text detected | Quote detection |
| Code blocks detected | Code detection |
| Neutral text produces no signals | No false positives |

### 7. `src/memory/context-sweep.test.ts` — Candidate extraction

| Test | What it verifies |
|------|-----------------|
| `extractCandidates()` extracts from conversation with clear preferences | Extraction pipeline |
| `extractCandidates()` respects `signalThreshold` config | Threshold filtering |
| `extractCandidates()` assigns correct classifications | Classification accuracy |
| `extractCandidates()` with empty conversation returns empty | Empty input |
| `extractCandidates()` with regex disabled only uses structural | Config toggle |

### 8. `src/memory/selective-memory.test.ts` — SelectiveMemory scoring & dedup

| Test | What it verifies |
|------|-----------------|
| `processAndStore()` creates memories from candidates | End-to-end creation |
| `processAndStore()` respects `maxMemoriesPerStop` (Miller's Law cap) | Limit enforcement |
| `processAndStore()` deduplicates against existing memories | Dedup with threshold |
| `processAndStore()` assigns correct project scope | Scope assignment |
| Scoring produces higher scores for more important candidates | Importance ordering |

### 9. `src/hooks/stop.test.ts` — Stop hook

| Test | What it verifies |
|------|-----------------|
| Extracts memories from `conversationText` | Text extraction path |
| Returns `memoriesCreated` count | Output contract |
| Handles missing session gracefully | Error path |

### 10. `src/retrieval/index.test.ts` — MemoryRetrieval

| Test | What it verifies |
|------|-----------------|
| `search(query, limit)` returns relevant memories ranked by score | Search ranking |
| `search()` with no matches returns empty | Empty result |
| Jaccard similarity computation is correct | Similarity math |
| Progressive disclosure respects token budget | Token limiting |
| Scope-based retrieval returns correct subset | Scope filtering |
| `search()` respects `includeDecayed` filter | Status filter |

### 11. `src/hooks/index.test.ts` — PsychMemHooks dispatcher

| Test | What it verifies |
|------|-----------------|
| `handleHook()` dispatches to correct handler per hookType | Routing |
| `handleHook()` for all 5 hook types returns `HookOutput` | Contract |
| Unknown hookType returns error | Error handling |

### 12. `src/hooks/session-start.test.ts` — SessionStart hook

| Test | What it verifies |
|------|-----------------|
| Creates session and returns context with memories | Happy path |
| Returns empty context when no memories exist | Empty state |
| Injects user-level memories regardless of project | Scope behavior |
| Only injects matching project memories | Project filtering |

### 13. `src/hooks/stop.test.ts` — Stop hook

| Test | What it verifies |
|------|-----------------|
| Extracts memories from `conversationText` | Text extraction path |
| Returns `memoriesCreated` count | Output contract |
| Handles missing session gracefully | Error path |

### 14. `src/hooks/session-end.test.ts` — SessionEnd hook

| Test | What it verifies |
|------|-----------------|
| Runs decay + consolidation | Side effects |
| Ends session with 'completed' status | Status update |
| Transaction atomicity (decay + consolidation together) | Transaction safety |

### 15. `src/hooks/post-tool-use.test.ts` — PostToolUse hook

| Test | What it verifies |
|------|-----------------|
| Captures tool use event | Event creation |
| Stores toolName, toolInput, toolOutput | Field persistence |

### 16. `src/cli.test.ts` — CLI & hook output format

| Test | What it verifies |
|------|-----------------|
| `handleHook()` with valid JSON processes correctly | Input handling |
| `handleHook()` with invalid JSON writes error to stderr, exits 0 | Error handling |

### 17. `src/core.test.ts` — PsychMem facade

| Test | What it verifies |
|------|-----------------|
| `createPsychMem()` returns initialized PsychMem instance | Factory |
| `handleHook()` delegates to PsychMemHooks | Delegation |
| `search()` delegates to MemoryRetrieval | Delegation |
| `getStats()` returns valid statistics | Stats contract |
| `pinMemory()` / `forgetMemory()` work through facade | Feedback pass-through |
| `applyDecay()` / `runConsolidation()` accessible via facade | Maintenance methods |

### 18. `src/index.test.ts` — Plugin entry point

| Test | What it verifies |
|------|-----------------|
| Module exports exactly 2 items: `PsychMemPlugin` + `default` | Export safety (Issue #5) |
| Both exports are async functions (not class constructors) | Callable check |

---

## Priority Order for Implementation

| Priority | Files | Rationale |
|----------|-------|-----------|
| **P0 — Core** | `database.test.ts`, `core.test.ts` | Everything depends on storage + facade |
| **P1 — Memory** | `patterns.test.ts`, `structural-analyzer.test.ts`, `context-sweep.test.ts`, `selective-memory.test.ts` | The extraction pipeline is the brain |
| **P2 — Hooks** | `hooks/index.test.ts`, `session-start.test.ts`, `stop.test.ts`, `session-end.test.ts`, `post-tool-use.test.ts` | Integration points |
| **P3 — Retrieval** | `retrieval/index.test.ts` | Search |
| **P4 — Edge** | `types/index.test.ts`, `utils/paths.test.ts`, `sqlite-adapter.test.ts`, `cli.test.ts`, `index.test.ts` | Support & safety |

---

## Estimated Scope

- **18 test files**, ~110 individual test cases
- All using `node:test` + `node:assert`
- Each file self-contained with temp database setup/teardown
- Total estimated effort: ~1,500-2,000 lines of test code
