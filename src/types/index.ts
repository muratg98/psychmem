/**
 * PsychMem Type Definitions
 * Psych-grounded selective memory system for AI agents
 */

// =============================================================================
// Agent Types
// =============================================================================

/**
 * Supported AI agent types
 */
export type AgentType = 'opencode';

// =============================================================================
// Memory Types (Psychological Framing)
// =============================================================================

/**
 * Memory classification aligned with psychological memory models
 * - episodic: time-stamped events ("what happened")
 * - semantic: distilled facts/rules ("what is true")
 * - procedural: workflows/patterns ("how we do it")
 * - bugfix: captured bug + fix pairs (auto-promote to LTM)
 * - learning: captured learnings (auto-promote to LTM)
 * - preference: user preferences
 * - decision: architectural/design decisions
 * - constraint: limitations, rules, constraints
 */
export type MemoryClassification =
  | 'episodic'
  | 'semantic'
  | 'procedural'
  | 'bugfix'
  | 'learning'
  | 'preference'
  | 'decision'
  | 'constraint';

/**
 * Memory scope determines injection behavior:
 * - user: Generic memories (constraints, preferences, learnings, procedural)
 *         Always injected regardless of current project
 * - project: Project-specific memories (decisions, bugfixes, episodic, semantic)
 *            Only injected when working on the same project
 */
export type MemoryScope = 'user' | 'project';

/**
 * Classifications that are user-level (always injected)
 * These are generic preferences/constraints that apply across all projects
 */
export const USER_LEVEL_CLASSIFICATIONS: MemoryClassification[] = [
  'constraint',
  'preference',
  'learning',
  'procedural',
];

/**
 * Classifications that are project-level (only injected for matching project)
 * These are context-specific to a particular codebase/project
 */
export const PROJECT_LEVEL_CLASSIFICATIONS: MemoryClassification[] = [
  'decision',
  'bugfix',
  'episodic',
  'semantic',
];

/**
 * Determine if a classification is user-level (always injected)
 */
export function isUserLevelClassification(classification: MemoryClassification): boolean {
  return USER_LEVEL_CLASSIFICATIONS.includes(classification);
}

/**
 * Get the appropriate scope for a classification
 */
export function getScopeForClassification(classification: MemoryClassification): MemoryScope {
  return isUserLevelClassification(classification) ? 'user' : 'project';
}

/**
 * Memory store type
 * - stm: Short-term memory (fast decay, task-relevant)
 * - ltm: Long-term memory (slow decay, consolidated)
 */
export type MemoryStore = 'stm' | 'ltm';

/**
 * Memory status for lifecycle management
 */
export type MemoryStatus = 'active' | 'decayed' | 'pinned' | 'forgotten';

// =============================================================================
// Core Data Models
// =============================================================================

/**
 * Session metadata
 */
export interface Session {
  id: string;
  project: string;
  startedAt: Date;
  endedAt?: Date | undefined;
  status: 'active' | 'completed' | 'abandoned';
  metadata?: Record<string, unknown> | undefined;
  
  // Message tracking for incremental parsing (OpenCode)
  messageWatermark?: number | undefined; // Index of last processed message (0-indexed)
}

/**
 * Raw event captured from hooks
 */
export interface Event {
  id: string;
  sessionId: string;
  hookType: HookType;
  timestamp: Date;
  content: string;
  toolName?: string | undefined;
  toolInput?: string | undefined;
  toolOutput?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

/**
 * Consolidated memory unit with psych + math features
 */
export interface MemoryUnit {
  id: string;
  sessionId?: string | undefined; // Session that created this memory (for deduplication)
  store: MemoryStore;
  classification: MemoryClassification;
  summary: string;
  sourceEventIds: string[];
  
  // Scope and project context (v1.6)
  projectScope?: string | undefined; // Project path for project-level memories, null/undefined for user-level
  
  // Timestamps
  createdAt: Date;
  updatedAt: Date;
  lastAccessedAt: Date;
  
  // Psych-math features
  recency: number;        // Time since creation (computed)
  frequency: number;      // Access/mention count
  importance: number;     // Explicit + inferred (0-1)
  utility: number;        // Task usefulness (0-1)
  novelty: number;        // Distinctiveness (0-1)
  confidence: number;     // Evidence consensus (0-1)
  interference: number;   // Conflict penalty (0-1)
  
  // Computed
  strength: number;       // Overall memory strength (0-1)
  decayRate: number;      // Lambda for exponential decay
  
  // Organization
  tags: string[];
  associations: string[]; // Related memory IDs
  
  // Vector embedding (optional — populated asynchronously after memory creation)
  // Stored as a Float32Array; serialised to BLOB in SQLite.
  embedding?: Float32Array | undefined;
  
  // Status
  status: MemoryStatus;
  version: number;
  
  // Evidence tracking
  evidence: MemoryEvidence[];
}

/**
 * Evidence linking memory to source events
 */
export interface MemoryEvidence {
  eventId: string;
  timestamp: Date;
  contribution: string;   // What this event contributed
  confidenceDelta: number; // How much it changed confidence
}

/**
 * Retrieval log for feedback learning
 */
export interface RetrievalLog {
  id: string;
  sessionId: string;
  memoryId: string;
  query: string;
  timestamp: Date;
  wasUsed: boolean;       // Did the agent actually use this memory?
  userFeedback?: 'positive' | 'negative' | 'neutral';
  relevanceScore: number; // Computed relevance at retrieval time
}

/**
 * User feedback for explicit memory control
 */
export interface Feedback {
  id: string;
  memoryId?: string;
  type: 'remember' | 'forget' | 'pin' | 'correct';
  content?: string;       // For corrections
  timestamp: Date;
}

// =============================================================================
// Hook Types
// =============================================================================

export type HookType =
  | 'SessionStart'
  | 'UserPromptSubmit'
  | 'PostToolUse'
  | 'Stop'
  | 'SessionEnd';

/**
 * Hook input payload (from agent system)
 */
export interface HookInput {
  hookType: HookType;
  sessionId: string;
  timestamp: string;
  data: HookData;
}

export type HookData =
  | SessionStartData
  | UserPromptSubmitData
  | PostToolUseData
  | StopData
  | SessionEndData;

export interface SessionStartData {
  project: string;
  workingDirectory: string;
  metadata?: Record<string, unknown>;
}

export interface UserPromptSubmitData {
  prompt: string;
  metadata?: Record<string, unknown>;
}

export interface PostToolUseData {
  toolName: string;
  toolInput: string;
  toolOutput: string;
  success: boolean;
  duration?: number;
  metadata?: Record<string, unknown>;
}

export interface StopData {
  reason: 'user' | 'complete' | 'error' | 'timeout' | 'compaction';
  stopReason?: string;        // Alternative field name for compatibility
  conversationText?: string;  // Full conversation text to process for memories
  summary?: string;
  metadata?: Record<string, unknown>;
}

export interface SessionEndData {
  reason: 'normal' | 'clear' | 'abandoned';
  metadata?: Record<string, unknown>;
}

/**
 * Hook output response
 */
export interface HookOutput {
  success: boolean;
  context?: string;           // For SessionStart: injected memory context
  error?: string;
  memoriesCreated?: number;   // For Stop: number of memories created
}

// =============================================================================
// Context Sweep Types
// =============================================================================

/**
 * Candidate extracted during context sweep
 */
export interface MemoryCandidate {
  summary: string;
  classification: MemoryClassification;
  sourceEventIds: string[];
  
  // Preliminary scores
  importanceSignals: ImportanceSignal[];
  preliminaryImportance: number;
  
  // Extraction metadata
  extractionMethod: string;
  confidence: number;
}

/**
 * Importance signal detected during extraction
 */
export interface ImportanceSignal {
  type: ImportanceSignalType;
  source: string;
  weight: number;
}

export type ImportanceSignalType =
  // Keyword-based signals (multilingual regex)
  | 'explicit_remember'    // User said "remember this"
  | 'emphasis_cue'         // "always", "never", "important"
  | 'correction'           // User corrected something
  | 'repeated_request'     // Mentioned multiple times
  | 'emotional_language'   // Strong language
  | 'tool_failure'         // Bug or error
  | 'bug_fix'              // Fixed a bug
  | 'decision'             // Made a decision
  | 'constraint'           // Stated a constraint
  | 'preference'           // Expressed preference
  | 'learning'             // Learned something new
  // Structural signals (language-agnostic)
  | 'typography_emphasis'  // ALL CAPS, exclamation marks, bold/emphasis markdown
  | 'correction_pattern'   // Short reply after long (conversational correction)
  | 'repetition_pattern'   // Trigram overlap > 60% (user repeating themselves)
  | 'elaboration'          // Reply >2x median length (detailed explanation)
  | 'structural_enumeration' // Ordered lists, arrows, contrast markers
  | 'meta_reference'       // Near tool error, file paths, stack traces
  | 'quoted_text'          // Text in quotes (often important)
  | 'code_block';          // Code blocks (context-dependent importance)

// =============================================================================
// Scoring and Retrieval Types
// =============================================================================

/**
 * Feature vector for scoring model
 */
export interface MemoryFeatureVector {
  recency: number;
  frequency: number;
  importance: number;
  utility: number;
  novelty: number;
  confidence: number;
  interference: number;
}

/**
 * Scoring weights (rule-based v1, learned v2)
 */
export interface ScoringWeights {
  recency: number;
  frequency: number;
  importance: number;
  utility: number;
  novelty: number;
  confidence: number;
  interference: number; // Negative weight (penalty)
}

/**
 * Retrieval query
 */
export interface RetrievalQuery {
  query: string;
  filters?: RetrievalFilters | undefined;
  limit?: number | undefined;
  includeDecayed?: boolean | undefined;
}

export interface RetrievalFilters {
  store?: MemoryStore;
  classifications?: MemoryClassification[];
  minStrength?: number;
  tags?: string[];
  since?: Date;
}

/**
 * Retrieval result (index layer)
 */
export interface RetrievalIndexItem {
  id: string;
  summary: string;
  classification: MemoryClassification;
  store: MemoryStore;
  strength: number;
  estimatedTokens: number;
  relevanceScore: number;
}

/**
 * Retrieval result (detail layer)
 */
export interface RetrievalDetail extends MemoryUnit {
  relevanceScore: number;
  retrievalReason: string;
}

// =============================================================================
// Context Sweep Configuration
// =============================================================================

/**
 * Configuration for context sweep importance detection
 */
export interface SweepConfig {
  /** Weight multiplier for structural signals (default: 1.0) */
  structuralWeight: number;
  /** Minimum signal weight threshold to create a candidate (default: 0.3) */
  signalThreshold: number;
  /** Enable multilingual regex patterns (default: true) */
  enableRegexPatterns: boolean;
  /** Enable structural/pragmatic analysis (default: true) */
  enableStructuralAnalysis: boolean;
  /** Confidence for regex-based signals (default: 0.75) */
  regexConfidence: number;
  /** Confidence for structural-only signals (default: 0.5) */
  structuralConfidence: number;
}

export const DEFAULT_SWEEP_CONFIG: SweepConfig = {
  structuralWeight: 1.0,
  signalThreshold: 0.5,  // Raised from 0.3 — structural signals (code blocks, file paths at 0.25) no longer pass alone
  enableRegexPatterns: true,
  enableStructuralAnalysis: true,
  regexConfidence: 0.75,
  structuralConfidence: 0.5,
};

// =============================================================================
// Configuration
// =============================================================================

/**
 * OpenCode-specific configuration options
 */
export interface OpenCodeConfig {
  /** Inject memories into compaction context (default: true) */
  injectOnCompaction: boolean;
  /** Extract memories from conversation before compaction (default: true) */
  extractOnCompaction: boolean;
  /** Extract memories on each user message submission via chat.message hook (default: true) */
  extractOnUserMessage: boolean;
  /** Max memories to inject on compaction (default: 10) */
  maxCompactionMemories: number;
  /** Max memories to inject on session start (default: 10) */
  maxSessionStartMemories: number;
  /** Number of recent messages to include for context in per-message extraction (default: 3) */
  messageWindowSize: number;
  /** Minimum importance threshold for per-message extraction (default: 0.3 ≈ 2 of 7 signal groups) */
  messageImportanceThreshold: number;
}

export interface PsychMemConfig {
  // Agent identification
  agentType: AgentType;
  
  // Database - supports {agentType} template
  // e.g., '~/.psychmem/{agentType}/memory.db' -> '~/.psychmem/opencode/memory.db'
  dbPath: string;
  
  // Decay settings
  stmDecayRate: number;   // Lambda for STM (higher = faster decay)
  ltmDecayRate: number;   // Lambda for LTM (lower = slower decay)
  
  // Consolidation thresholds
  stmToLtmStrengthThreshold: number;  // Min strength to promote
  stmToLtmFrequencyThreshold: number; // Min frequency to promote
  
  // Scoring weights (v1 rule-based)
  scoringWeights: ScoringWeights;
  
  // Retrieval settings
  defaultRetrievalLimit: number;
  maxContextTokens: number;
  
  // Auto-promote classifications
  autoPromoteToLtm: MemoryClassification[];
  
  // Transcript parsing settings
  maxMemoriesPerStop: number;         // Miller's Law: 7±2 items in working memory
  deduplicationThreshold: number;     // Keyword overlap threshold (0-1)
  
  // Context sweep settings
  sweep: SweepConfig;
  
  // OpenCode-specific options
  opencode: OpenCodeConfig;
}

export const DEFAULT_CONFIG: PsychMemConfig = {
  agentType: 'opencode',
  dbPath: '~/.psychmem/{agentType}/memory.db',  // Template with agent type
  
  stmDecayRate: 0.05,     // ~32-hour half-life (doubled from 0.1)
  ltmDecayRate: 0.01,     // Slow decay
  
  stmToLtmStrengthThreshold: 0.7,
  stmToLtmFrequencyThreshold: 3,
  
  scoringWeights: {
    recency: 0.2,
    frequency: 0.15,
    importance: 0.25,
    utility: 0.2,
    novelty: 0.1,
    confidence: 0.1,
    interference: -0.1, // Penalty
  },
  
  defaultRetrievalLimit: 20,
  maxContextTokens: 4000,
  
  autoPromoteToLtm: ['bugfix', 'learning', 'decision'],
  
  // Transcript parsing (reduced from 7 — Miller's Law is generous, 4 keeps quality high)
  maxMemoriesPerStop: 4,
  deduplicationThreshold: 0.7, // 70% keyword overlap = duplicate
  
  // Context sweep settings
  sweep: DEFAULT_SWEEP_CONFIG,
  
  // OpenCode-specific defaults
  opencode: {
    injectOnCompaction: true,
    extractOnCompaction: true,
    extractOnUserMessage: true,  // Per-user-message extraction via chat.message hook
    maxCompactionMemories: 10,
    maxSessionStartMemories: 10,
    messageWindowSize: 3,    // Include last 3 messages for context
    messageImportanceThreshold: 0.3,   // At least 2 of 7 pattern groups must match (raised from 0.1)
  },
};
