/**
 * OpenCode Adapter for PsychMem
 * 
 * Handles OpenCode-specific event mapping and message processing:
 * - Maps OpenCode events to PsychMem hooks
 * - Processes messages incrementally using messageWatermark
 * - Formats and injects memories into OpenCode context
 */

import { mkdirSync, existsSync, statSync, renameSync } from 'fs';
import { appendFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import type {
  OpenCodePluginContext,
  OpenCodePluginHooks,
  OpenCodeMessageContainer,
  OpenCodeMessagePart,
  OpenCodeClient,
  OpenCodeToolInput,
  OpenCodeToolOutput,
  OpenCodeCompactionInput,
  OpenCodeChatMessageInput,
  OpenCodeChatMessageOutput,
  PsychMemAdapter,
} from '../types.js';
import type {
  PsychMemConfig,
  MemoryUnit,
  HookInput,
  StopData,
  PostToolUseData,
  SessionStartData,
} from '../../types/index.js';
import { DEFAULT_CONFIG, getScopeForClassification } from '../../types/index.js';
import { PsychMem, createPsychMem } from '../../core.js';
import { MemoryDatabase, createMemoryDatabase } from '../../storage/database.js';
import { MemoryRetrieval } from '../../retrieval/index.js';
import { filterConflicts } from '../../retrieval/conflict-filter.js';

// =============================================================================
// Debug logging — writes to ~/.psychmem/plugin-debug.log (max 10 MB, rotated once)
// =============================================================================

const _psychmemDir = join(homedir(), '.psychmem');
const _logFile = join(_psychmemDir, 'plugin-debug.log');
const _logFileOld = join(_psychmemDir, 'plugin-debug.log.1');
const LOG_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

if (!existsSync(_psychmemDir)) {
  try { mkdirSync(_psychmemDir, { recursive: true }); } catch (_) { /* ignore */ }
}

function debugLog(msg: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] [adapter] ${msg}\n`;
  // Fire-and-forget: rotate then append asynchronously (no blocking)
  (async () => {
    try {
      // Rotate if log exceeds 10 MB
      try {
        if (statSync(_logFile).size >= LOG_MAX_BYTES) {
          renameSync(_logFile, _logFileOld);
        }
      } catch (_) { /* file may not exist yet */ }
      await appendFile(_logFile, line);
    } catch (_) { /* ignore logging errors */ }
  })();
}

// =============================================================================
// Session ID extraction helpers
// =============================================================================

/**
 * Extract a session ID from an event's properties object.
 * 
 * SDK shapes:
 * - session.created  → properties.info.id
 * - session.idle     → properties.sessionID
 * - session.deleted  → properties.info.id
 * - session.error    → properties.sessionID  (or properties.info?.id)
 */
function getSessionIdFromEvent(properties?: Record<string, unknown>): string | undefined {
  if (!properties) return undefined;

  // Try properties.info.id (session.created, session.deleted)
  const info = properties.info as Record<string, unknown> | undefined;
  if (info && typeof info.id === 'string') return info.id;

  // Try properties.sessionID (session.idle, session.error)
  if (typeof properties.sessionID === 'string') return properties.sessionID;

  // Fallback: properties.id (shouldn't happen with current SDK, but safe)
  if (typeof properties.id === 'string') return properties.id;

  return undefined;
}

// =============================================================================
// Plugin config helpers — shared with plugin.js and src/index.ts default export
// =============================================================================

function parseEnvBool(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  return value.toLowerCase() === 'true' || value === '1';
}

function parseEnvNumber(value: string | undefined, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

function parseEnvFloat(value: string | undefined, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  const parsed = parseFloat(value);
  return isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Build PsychMemConfig from PSYCHMEM_* environment variables.
 * Used by plugin.js and the default export in src/index.ts.
 */
export function parsePluginConfig(): Partial<PsychMemConfig> {
  return {
    opencode: {
      injectOnCompaction:          parseEnvBool  (process.env['PSYCHMEM_INJECT_ON_COMPACTION'],         true),
      extractOnCompaction:         parseEnvBool  (process.env['PSYCHMEM_EXTRACT_ON_COMPACTION'],        true),
      extractOnUserMessage:        parseEnvBool  (process.env['PSYCHMEM_EXTRACT_ON_USER_MESSAGE'] ?? process.env['PSYCHMEM_EXTRACT_ON_MESSAGE'], true),
      maxCompactionMemories:       parseEnvNumber(process.env['PSYCHMEM_MAX_COMPACTION_MEMORIES'],      10),
      maxSessionStartMemories:     parseEnvNumber(process.env['PSYCHMEM_MAX_SESSION_MEMORIES'],         10),
      messageWindowSize:           parseEnvNumber(process.env['PSYCHMEM_MESSAGE_WINDOW_SIZE'],          3),
      messageImportanceThreshold:  parseEnvFloat (process.env['PSYCHMEM_MESSAGE_IMPORTANCE_THRESHOLD'], 0.3),
    },
  };
}

// =============================================================================

/**
 * OpenCode adapter instance state
 */
interface OpenCodeAdapterState {
  psychmem: PsychMem;
  db: MemoryDatabase;
  retrieval: MemoryRetrieval;
  config: PsychMemConfig;
  currentSessionId: string | null;
  /** Sessions that have already received a memory injection this process lifetime */
  injectedSessions: Set<string>;
  /**
   * Per-process watermark map: OpenCode session ID → number of messages already
   * processed by handleSessionIdle.  Keyed by the OpenCode external session ID
   * (e.g. "ses_36cbdd4d6ffeGT6CgTCeHSfRsG") so it survives OpenCode session
   * continuations (-c) without being confused by PsychMem's internal UUIDs.
   */
  messageWatermarks: Map<string, number>;
  worktree: string;
  client: OpenCodeClient;
}

/**
 * Create OpenCode plugin hooks with PsychMem integration
 */
export async function createOpenCodePlugin(
  ctx: OpenCodePluginContext,
  configOverrides: Partial<PsychMemConfig> = {}
): Promise<OpenCodePluginHooks> {
  // Initialize with OpenCode-specific config
  const config: PsychMemConfig = {
    ...DEFAULT_CONFIG,
    agentType: 'opencode',
    ...configOverrides,
  };
  
  // Initialize PsychMem components (async for Bun compatibility)
  // Create a single DB connection shared by psychmem and the adapter state
  const db = await createMemoryDatabase(config);
  const psychmem = await createPsychMem(config, db);
  const retrieval = new MemoryRetrieval(db, config);
  
  // Resolve project root: ctx.worktree returns "/" on Windows, fall back to ctx.directory
  const worktree = (!ctx.worktree || ctx.worktree === '/' || ctx.worktree === '\\')
    ? ctx.directory
    : ctx.worktree;
  
  // Adapter state
  const state: OpenCodeAdapterState = {
    psychmem,
    db,
    retrieval,
    config,
    currentSessionId: null,
    injectedSessions: new Set<string>(),
    messageWatermarks: new Map<string, number>(),
    worktree,
    client: ctx.client,
  };
  
  // Log initialization
  debugLog(`PsychMem initialized — worktree=${ctx.worktree}, directory=${ctx.directory}, resolved project=${worktree}`);
  log(ctx, 'info', `PsychMem initialized for project: ${worktree}`);
  
  return {
    /**
     * Handle session lifecycle events
     */
    event: async ({ event }) => {
      // Skip extremely noisy streaming events entirely
      const silentEvents = new Set([
        'message.part.delta',
        'message.part.updated',
        'session.diff',
      ]);
      if (silentEvents.has(event.type)) return;
      
      // For handled events, log full details; for others, just log type
      const handledEvents = new Set([
        'session.created', 'session.idle', 'session.deleted', 'session.error',
      ]);
      
      if (handledEvents.has(event.type)) {
        debugLog(`Event: ${event.type} — properties: ${JSON.stringify(event.properties, null, 2)}`);
      } else {
        debugLog(`Event (skipped): ${event.type}`);
      }
      
      const sessionId = getSessionIdFromEvent(event.properties);
      
      switch (event.type) {
        case 'session.created':
          await handleSessionCreated(state, ctx, sessionId);
          break;
          
        case 'session.idle':
          await handleSessionIdle(state, ctx, sessionId);
          break;
          
        case 'session.deleted':
        case 'session.error':
          await handleSessionEnd(state, ctx, event.type, sessionId);
          break;
      }
    },
    
    /**
     * Hook after tool execution - capture tool results
     * 
     * SDK shapes:
     *   input:  { tool: string, sessionID: string, callID: string, args: any }
     *   output: { title: string, output: string, metadata: any }
     */
    'tool.execute.after': async (input: OpenCodeToolInput, output: OpenCodeToolOutput) => {
      debugLog(`tool.execute.after: tool=${input.tool}, sessionID=${input.sessionID}, callID=${input.callID}`);
      
      // Use input.sessionID as fallback if state doesn't have one yet
      if (!state.currentSessionId && input.sessionID) {
        debugLog(`Setting currentSessionId from tool input: ${input.sessionID}`);
        state.currentSessionId = input.sessionID;
      }
      
      if (!state.currentSessionId) {
        debugLog(`tool.execute.after: no session ID available, skipping`);
        return;
      }
      
      await handlePostToolUse(state, ctx, input, output);
    },

    /**
     * Fires exactly once per user turn, before the assistant starts responding.
     *
     * Two responsibilities:
     * 1. LAZY INJECTION — single injection path for ALL sessions (new or continued).
     *    On the first user message of any session, inject memories before the assistant
     *    responds. This handles both fresh sessions (session.created fires but no user
     *    message yet) and continued sessions (-c flag, which skips session.created).
     * 2. PER-MESSAGE EXTRACTION — fire-and-forget extraction after each user message.
     *    Only runs when extractOnUserMessage is enabled and the message passes
     *    the importance pre-filter (positive signals present, not a pure task command).
     */
    'chat.message': async (input: OpenCodeChatMessageInput, output: OpenCodeChatMessageOutput) => {
      await handleUserMessage(state, ctx, input, output);
    },

    /**
      * Experimental: Extract and inject memories during session compaction
      * 
      * Compaction happens when the conversation context grows too large.
      * This is a critical moment to:
      * 1. EXTRACT: Sweep the conversation for important memories before they're compressed
      * 2. INJECT: Control exactly what gets preserved via output.prompt
      * 
      * IMPORTANT: Setting output.prompt REPLACES the entire compaction prompt,
      * giving us full control over what the LLM preserves during compaction.
      */
    'experimental.session.compacting': async (input: OpenCodeCompactionInput, output) => {
      debugLog(`Compaction hook triggered — input: ${JSON.stringify(input)}`);
      
      const sessionId = input.sessionID ?? state.currentSessionId;
      
      // Phase 1: EXTRACT memories from conversation before compaction
      if (state.config.opencode.extractOnCompaction && sessionId) {
        try {
          const extractionResult = await handleCompactionExtraction(state, ctx, sessionId);
          if (extractionResult.memoriesCreated > 0) {
            log(ctx, 'info', `Compaction sweep: extracted ${extractionResult.memoriesCreated} memories before compaction`);
          }
        } catch (error) {
          debugLog(`Compaction extraction failed: ${error}`);
          log(ctx, 'warn', `Compaction extraction failed: ${error}`);
        }
      }
      
      // Phase 2: INJECT memories into compaction context
      // We use output.prompt to REPLACE the entire compaction prompt
      // This gives us precise control over what gets preserved
      if (state.config.opencode.injectOnCompaction) {
        const memories = await getRelevantMemories(
          state,
          state.config.opencode.maxCompactionMemories
        );
        
        if (memories.length > 0) {
          const memoryContext = formatMemoriesForInjection(memories, 'compaction', state.worktree);
          
          // Build a custom compaction prompt that includes our memories
          output.prompt = buildCompactionPrompt(memoryContext);
          
          log(ctx, 'info', `Injected ${memories.length} memories into compaction prompt`);
          debugLog(`Compaction prompt set with ${memories.length} memories`);
        } else {
          // Even with no memories, we can still provide an optimized compaction prompt
          output.prompt = buildCompactionPrompt(null);
          debugLog(`Compaction prompt set (no memories to inject)`);
        }
      }
    },
  };
}

/**
 * Handle session.created event
 */
async function handleSessionCreated(
  state: OpenCodeAdapterState,
  ctx: OpenCodePluginContext,
  sessionId?: string
): Promise<void> {
  debugLog(`handleSessionCreated called with sessionId=${sessionId ?? 'NONE'}`);
  
  if (!sessionId) {
    debugLog('handleSessionCreated: no sessionId — BAILING');
    return;
  }
  
  state.currentSessionId = sessionId;
  // Do NOT pre-mark as injected here — let chat.message handle injection lazily.
  // This ensures injection always happens in the correct position (just before
  // the first user message), whether the session was freshly created or continued.
  debugLog(`state.currentSessionId set to: ${sessionId}`);
  
  // Create session in PsychMem
  const hookInput: HookInput = {
    hookType: 'SessionStart',
    sessionId,
    timestamp: new Date().toISOString(),
    data: {
      project: state.worktree,
      workingDirectory: ctx.directory,
      metadata: { agentType: 'opencode' },
    } as SessionStartData,
  };
  
  await state.psychmem.handleHook(hookInput);
  
  log(ctx, 'info', `Session started: ${sessionId}`);
}

/**
 * Handle session.idle event - extract memories from new messages
 */
async function handleSessionIdle(
  state: OpenCodeAdapterState,
  ctx: OpenCodePluginContext,
  sessionId?: string
): Promise<void> {
  const effectiveSessionId = sessionId ?? state.currentSessionId;
  debugLog(`handleSessionIdle called — sessionId=${sessionId ?? 'NONE'}, state.currentSessionId=${state.currentSessionId ?? 'NONE'}, effective=${effectiveSessionId ?? 'NONE'}`);
  
  if (!effectiveSessionId) {
    debugLog('handleSessionIdle: no effective sessionId — BAILING');
    return;
  }
  
  // Update state if we got a session ID from the event
  if (sessionId && !state.currentSessionId) {
    state.currentSessionId = sessionId;
    debugLog(`state.currentSessionId set from idle event: ${sessionId}`);
  }
  
  // Get current watermark from in-process map (keyed by OpenCode session ID).
  // Using in-memory map rather than the DB because the DB watermark is stored
  // against PsychMem's internal UUID — which changes every restart — not the
  // OpenCode session ID, so db.getMessageWatermark always returned 0.
  const watermark = state.messageWatermarks.get(effectiveSessionId) ?? 0;
  debugLog(`Watermark for session ${effectiveSessionId}: ${watermark}`);
  
  // Fetch messages from OpenCode
  let messages: OpenCodeMessageContainer[];
  try {
    const response = await state.client.session.messages({
      path: { id: effectiveSessionId },
    });
    messages = response.data;
    debugLog(`Fetched ${messages?.length ?? 0} messages for session ${effectiveSessionId}`);
  } catch (error) {
    debugLog(`Failed to fetch messages: ${error}`);
    return;
  }
  
  if (!messages || messages.length <= watermark) {
    debugLog(`No new messages (total=${messages?.length ?? 0}, watermark=${watermark})`);
    return; // No new messages to process
  }
  
  // Extract text from new messages
  const newMessages = messages.slice(watermark);
  const conversationText = extractConversationText(newMessages);
  
  if (!conversationText.trim()) {
    state.messageWatermarks.set(effectiveSessionId, messages.length);
    debugLog('No text content in new messages, updated watermark only');
    return;
  }
  
  debugLog(`Extracted ${conversationText.length} chars of conversation text from ${newMessages.length} new messages`);
  
  // Process through Stop hook (extracts memories)
  const hookInput: HookInput = {
    hookType: 'Stop',
    sessionId: effectiveSessionId,
    timestamp: new Date().toISOString(),
    data: {
      reason: 'user', // session.idle typically means user turn
      conversationText,
      metadata: {
        messageRange: { from: watermark, to: messages.length },
        agentType: 'opencode',
        project: state.worktree, // passed so auto-create session gets the right project
      },
    } as StopData,
  };
  
  const result = await state.psychmem.handleHook(hookInput);
  
  // Update watermark only after successful (or at least attempted) processing
  state.messageWatermarks.set(effectiveSessionId, messages.length);
  
  if (result.success) {
    const memoriesCreated = result.memoriesCreated ?? 0;
    debugLog(`Stop hook succeeded — processed ${newMessages.length} messages, watermark now: ${messages.length}, memories created: ${memoriesCreated}`);
    if (memoriesCreated > 0) {
      log(ctx, 'info', `Extracted ${memoriesCreated} memories (watermark: ${messages.length})`);
    } else {
      log(ctx, 'debug', `Processed ${newMessages.length} messages, watermark: ${messages.length}, no new memories`);
    }
  } else {
    debugLog(`Stop hook returned success=false — error: ${result.error ?? 'unknown'}`);
    log(ctx, 'warn', `Stop hook failed: ${result.error ?? 'unknown'}`);
  }
}

/**
 * Handle session end events
 */
async function handleSessionEnd(
  state: OpenCodeAdapterState,
  ctx: OpenCodePluginContext,
  eventType: string,
  sessionId?: string
): Promise<void> {
  const effectiveSessionId = sessionId ?? state.currentSessionId;
  debugLog(`handleSessionEnd: eventType=${eventType}, sessionId=${sessionId ?? 'NONE'}, effective=${effectiveSessionId ?? 'NONE'}`);
  
  if (!effectiveSessionId) {
    debugLog('handleSessionEnd: no effective sessionId — BAILING');
    return;
  }
  
  const reason = eventType === 'session.error' ? 'abandoned' : 'normal';
  
  const hookInput: HookInput = {
    hookType: 'SessionEnd',
    sessionId: effectiveSessionId,
    timestamp: new Date().toISOString(),
    data: {
      reason,
      metadata: { agentType: 'opencode', eventType },
    },
  };
  
  await state.psychmem.handleHook(hookInput);
  
  state.currentSessionId = null;
  debugLog(`Session ended: ${effectiveSessionId} (${reason})`);
  log(ctx, 'info', `Session ended: ${effectiveSessionId} (${reason})`);
}

/**
 * Handle chat.message hook — fires exactly once per user turn, before the assistant responds.
 *
 * Two responsibilities:
 * 1. LAZY INJECTION — single injection path for ALL sessions (new and continued).
 *    On the first user message, inject relevant memories before the assistant starts
 *    responding. handleSessionCreated no longer injects so that injection always
 *    happens at exactly the right moment (just before the first real user turn).
 * 2. PER-MESSAGE EXTRACTION — if extractOnUserMessage is enabled, extract text from the
 *    user's message parts (no API call needed), run the importance pre-filter, and if it
 *    passes, fire the full extraction pipeline fire-and-forget so the assistant can start
 *    responding immediately.
 *
 * The extraction uses a sliding window of the last N messages fetched from the session
 * API — this gives context around the user message, not just the message in isolation.
 */
async function handleUserMessage(
  state: OpenCodeAdapterState,
  ctx: OpenCodePluginContext,
  input: OpenCodeChatMessageInput,
  output: OpenCodeChatMessageOutput
): Promise<void> {
  const sessionId = input.sessionID ?? state.currentSessionId;
  debugLog(`handleUserMessage: sessionId=${sessionId ?? 'NONE'}, messageID=${input.messageID ?? 'NONE'}`);

  if (!sessionId) {
    debugLog('handleUserMessage: no sessionId — BAILING');
    return;
  }

  // Skip injected noReply messages (e.g. the memory block we just injected).
  // These echo back through chat.message with no messageID and must not be
  // re-extracted as memories — they are our own output, not user input.
  if (!input.messageID) {
    debugLog('handleUserMessage: no messageID — skipping (injected noReply echo)');
    return;
  }

  // Ensure state is up to date
  if (!state.currentSessionId) {
    state.currentSessionId = sessionId;
  }

  // Extract user message text early — needed both for injection query and
  // for per-message extraction below.
  const userText = output.parts
    .filter(p => p.type === 'text' && p.text)
    .map(p => p.text!)
    .join('\n')
    .trim();

  debugLog(`handleUserMessage: user message text (${userText.length} chars): ${userText.slice(0, 120)}`);

  // --- QUERY-AWARE LAZY INJECTION ---
  // Inject memories on the first user message of a session.  The user's message
  // text is used as a retrieval query so memories are ranked by relevance to the
  // task at hand rather than by raw strength.  We wait until we have a real user
  // message because only then do we know what context to retrieve against.
  if (!state.injectedSessions.has(sessionId)) {
    state.injectedSessions.add(sessionId);
    debugLog(`Lazy injection: first user message in session ${sessionId}`);
    const queryText = userText || undefined;
    const candidates = await getRelevantMemories(state, state.config.opencode.maxSessionStartMemories, queryText);
    const budgeted = applyInjectionBudget(candidates);
    const { clean: memories, suppressed } = filterConflicts(budgeted);
    if (suppressed.length > 0) {
      debugLog(`Conflict filter suppressed ${suppressed.length} memories: ${suppressed.map(s => s.memory.summary.slice(0, 40)).join('; ')}`);
    }
    if (memories.length > 0) {
      const memoryContext = formatMemoriesForInjection(memories, 'session_start', state.worktree);
      await injectContext(state, sessionId, memoryContext);
      log(ctx, 'info', `Lazy injection: ${memories.length} memories (query-aware, STM-first, conflict-filtered) on first user message`);
      debugLog(`Lazy injection: injected ${memories.length} memories (${memories.filter(m=>m.store==='stm').length} STM, ${memories.filter(m=>m.store==='ltm').length} LTM) with query="${(queryText ?? '').slice(0, 60)}"`);
    }
  }

  // --- PER-MESSAGE EXTRACTION ---
  if (!state.config.opencode.extractOnUserMessage) {
    debugLog('handleUserMessage: extractOnUserMessage disabled — skipping extraction');
    return;
  }

  if (!userText) {
    debugLog('handleUserMessage: no text content in user message parts, skipping extraction');
    return;
  }

  // Importance pre-filter using just the user message text (fast, no API call).
  const hasImportantContent = preFilterImportance(userText, state.config.opencode.messageImportanceThreshold);

  if (!hasImportantContent) {
    debugLog('handleUserMessage: message did not pass importance pre-filter, skipping extraction');
    return;
  }

  // Fire-and-forget: fetch context window and run extraction async.
  // The assistant starts responding immediately; extraction runs in the background.
  const windowSize = state.config.opencode.messageWindowSize;
  const capturedSessionId = sessionId;

  void (async () => {
    try {
      const response = await state.client.session.messages({ path: { id: capturedSessionId } });
      const messages = response.data;
      if (!messages || messages.length === 0) return;

      const recentMessages = messages.slice(-windowSize);
      const conversationText = extractConversationText(recentMessages);
      if (!conversationText.trim()) return;

      const hookInput: HookInput = {
        hookType: 'Stop',
        sessionId: capturedSessionId,
        timestamp: new Date().toISOString(),
        data: {
          reason: 'user',
          conversationText,
          metadata: {
            agentType: 'opencode',
            isPerUserMessageExtraction: true,
            windowSize,
            messageCount: recentMessages.length,
          },
        } as StopData,
      };

      const result = await state.psychmem.handleHook(hookInput);

      if (result.success && result.memoriesCreated && result.memoriesCreated > 0) {
        debugLog(`handleUserMessage: created ${result.memoriesCreated} memories from per-user-message extraction`);
        log(ctx, 'debug', `Per-message extraction: ${result.memoriesCreated} memories`);
      } else {
        debugLog('handleUserMessage: extraction ran, no new memories created');
      }
    } catch (err) {
      debugLog(`handleUserMessage: extraction error — ${err}`);
    }
  })();
}

/**
 * Pre-filter for per-user-message extraction.
 *
 * Two gates:
 *
 * 1. DISQUALIFICATION gate — skips extraction for pure task commands.
 *    If the message starts with an imperative verb AND has no positive
 *    memory signals, it is a task request with nothing worth storing.
 *    If the message DOES contain a memory signal it bypasses this gate
 *    and is immediately passed to Gate 2 (or returned true if threshold=0).
 *
 * 2. POSITIVE SIGNAL gate — score = matchCount / 7.
 *    Passes if score > threshold (strict greater-than so that a single match
 *    (score ≈ 0.143) passes a threshold of 0.14 or below, and the default
 *    threshold of 0.3 requires at least 3 of 7 groups to match).
 *    Special case: threshold === 0 always returns true.
 */
export function preFilterImportance(text: string, threshold: number): boolean {
  // Special case: threshold 0 means always pass.
  if (threshold === 0) return true;

  // Fast-reject: never extract our own injected memory blocks.
  // These headers are written by formatMemoriesForInjection() and must not
  // be re-ingested as new memories — they are already stored content.
  if (
    text.includes('## Relevant Memories from Previous Sessions') ||
    text.includes('## Preserved Memories (from PsychMem)')
  ) {
    debugLog('preFilterImportance: rejecting injected memory block');
    return false;
  }

  const memorySignalPattern = /remember|don't forget|keep in mind|note that|important|never|always|must|cannot|decided|decision|prefer|learned|realized|discovered|fixed|bug|error|wrong|incorrect|!{2,}/i;
  const emphasisPattern = /[A-Z]{4,}/; // case-sensitive: ALL_CAPS is an emphasis signal

  // Gate 1: Disqualify pure task commands only when no memory signal is present.
  // If a memory signal IS present in a task command, return true immediately —
  // the memory signal is what matters regardless of the imperative framing.
  const taskCommandPattern = /^\s*(go|run|execute|fetch|scrape|build|deploy|generate|create|write|open|start|stop|delete|remove|list|show|get|check|test|install|update|upgrade|download|clone|init|make|do|find)\b/i;
  const hasMemorySignal = memorySignalPattern.test(text) || emphasisPattern.test(text);

  if (taskCommandPattern.test(text)) {
    if (!hasMemorySignal) {
      debugLog(`preFilterImportance: task command disqualified — "${text.slice(0, 80)}"`);
      return false;
    }
    // Task command but has a memory signal — return true immediately.
    debugLog(`preFilterImportance: task command with memory signal — passing immediately`);
    return true;
  }

  // Gate 2: Positive signal matching.
  // Score is the fraction of the 7 pattern groups that match.
  const highImportancePatterns = [
    // Explicit memory requests
    /remember|don't forget|keep in mind|note that|important/i,
    // Constraint/preference indicators
    /never|always|must|cannot|don't|won't|shouldn't|can't/i,
    // Bug/error indicators
    /bug|error|fix|fixed|issue|problem|broken|fail/i,
    // Decision indicators
    /decided|decision|chose|choice|prefer|better to|should use/i,
    // Learning indicators
    /learned|realized|discovered|found out|turns out|actually/i,
    // Correction indicators
    /no,|not|wrong|incorrect|actually|instead|rather/i,
    // Emphasis
    /!{2,}|[A-Z]{4,}/,
  ];

  let matchCount = 0;
  for (const pattern of highImportancePatterns) {
    if (pattern.test(text)) matchCount++;
  }

  // Score is the fraction of the 7 pattern groups that match.
  // Uses >= so that threshold=0.3 means matchCount/7 ≥ 0.3 → matchCount ≥ ceil(0.3*7)=3.
  const score = matchCount / highImportancePatterns.length;
  debugLog(`preFilterImportance: matchCount=${matchCount}/${highImportancePatterns.length}, score=${score.toFixed(3)}, threshold=${threshold}`);

  return score >= threshold;
}

/**
 * Handle post-tool-use event
 * 
 * SDK input:  { tool: string, sessionID: string, callID: string, args: any }
 * SDK output: { title: string, output: string, metadata: any }
 */
async function handlePostToolUse(
  state: OpenCodeAdapterState,
  ctx: OpenCodePluginContext,
  input: OpenCodeToolInput,
  output: OpenCodeToolOutput
): Promise<void> {
  const sessionId = state.currentSessionId;
  if (!sessionId) return;
  
  debugLog(`handlePostToolUse: tool=${input.tool}, output.title=${output.title}, output.output length=${output.output?.length ?? 0}`);
  
  // Truncate long output for storage
  const toolOutput = output.output && output.output.length > 2000
    ? output.output.slice(0, 2000) + '...[truncated]'
    : (output.output ?? '');
  
  const hookInput: HookInput = {
    hookType: 'PostToolUse',
    sessionId,
    timestamp: new Date().toISOString(),
    data: {
      toolName: input.tool,
      toolInput: JSON.stringify(input.args),
      toolOutput,
      success: true, // SDK doesn't separate error in output; errors come through session.error events
      metadata: { agentType: 'opencode', callID: input.callID, title: output.title },
    } as PostToolUseData,
  };
  
  await state.psychmem.handleHook(hookInput);
  debugLog(`PostToolUse hook completed for tool: ${input.tool}`);
}

/**
 * Extract conversation text from OpenCode messages.
 *
 * SDK Part shapes (relevant ones):
 *   - { type: 'text', text: string }
 *   - { type: 'tool', tool: string, state: { status, output?, error?, input? } }
 *
 * We only include text turns and completed/errored tool calls —
 * step-start/step-finish/snapshot/patch parts are skipped.
 */
function extractConversationText(messages: OpenCodeMessageContainer[]): string {
  const lines: string[] = [];

  // Headers used for injected memory blocks — must be stripped to prevent
  // memories from re-extracting themselves in a feedback loop
  const MEMORY_BLOCK_HEADERS = [
    '## Relevant Memories from Previous Sessions',
    '## Preserved Memories (from PsychMem)',
  ];

  for (const msg of messages) {
    const role = msg.info.role === 'user' ? 'Human' : 'Assistant';

    for (const part of msg.parts) {
      if (part.type === 'text' && part.text) {
        // Skip injected memory blocks entirely
        const text = part.text;
        if (MEMORY_BLOCK_HEADERS.some(h => text.includes(h))) continue;
        lines.push(`${role}: ${text}`);
      } else if (part.type === 'tool' && part.tool) {
        const state = part.state;
        if (!state) continue;

        if (state.status === 'completed') {
          // Only include tool name — raw output is noise (file contents,
          // grep results, etc.) that pollutes memory extraction
          lines.push(`Assistant: [Used tool: ${part.tool}]`);
        } else if (state.status === 'error') {
          lines.push(`Assistant: [Tool: ${part.tool}]`);
          if (state.error) {
            // Keep first line of error — useful for bugfix memories
            const errorOneLiner = state.error.split('\n')[0]?.slice(0, 200) || '';
            lines.push(`Tool Error: ${errorOneLiner}`);
          }
        }
      }
    }
  }

  return lines.join('\n');
}

/**
 * Get relevant memories for current context with scope-based filtering.
 *
 * When a query string is provided (the first user message text), memories are
 * re-ranked by relevance to that query using Jaccard/keyword similarity before
 * the limit is applied.  Without a query, falls back to strength-DESC ordering.
 *
 * Returns:
 * - All user-level memories (constraint, preference, learning, procedural)
 * - Project-level memories only for the current project
 */
async function getRelevantMemories(
  state: OpenCodeAdapterState,
  limit: number,
  query?: string
): Promise<MemoryUnit[]> {
  if (query && query.trim()) {
    return state.retrieval.retrieveByScopeWithQuery(query, {
      currentProject: state.worktree,
      limit,
    });
  }
  return state.retrieval.retrieveByScope({
    currentProject: state.worktree,
    limit,
  });
}

/**
 * Apply the STM-first injection budget.
 *
 * Phases 2 of the retrieval flow:
 *   1. STM memories go first (recency bias — mirrors human short-term recall).
 *      Capped at STM_CAP (default 3).
 *   2. Remaining budget filled with LTM memories.
 *   3. Total never exceeds TOTAL_CAP (default 7).
 *
 * The input list is already relevance-ranked by getRelevantMemories; this
 * function preserves that ranking within each tier.
 */
function applyInjectionBudget(
  memories: MemoryUnit[],
  stmCap: number = 3,
  totalCap: number = 7
): MemoryUnit[] {
  const stm = memories.filter(m => m.store === 'stm').slice(0, stmCap);
  const ltmBudget = totalCap - stm.length;
  const ltm = memories.filter(m => m.store === 'ltm').slice(0, ltmBudget);
  return [...stm, ...ltm];
}


function formatMemoriesForInjection(
  memories: MemoryUnit[],
  context: 'session_start' | 'compaction',
  currentProject?: string
): string {
  const header = context === 'session_start'
    ? '## Relevant Memories from Previous Sessions'
    : '## Preserved Memories (from PsychMem)';
  
  const lines: string[] = [header, ''];
  
  // Separate user-level and project-level memories
  const userLevelClassifications = ['constraint', 'preference', 'learning', 'procedural'];
  const userLevel = memories.filter(m => userLevelClassifications.includes(m.classification));
  const projectLevel = memories.filter(m => !userLevelClassifications.includes(m.classification));
  
  // User-level memories (always applicable)
  if (userLevel.length > 0) {
    lines.push('### User Preferences & Constraints');
    lines.push('_These apply across all projects_');
    lines.push('');
    
    // Group by classification
    const byClass = new Map<string, MemoryUnit[]>();
    for (const mem of userLevel) {
      const existing = byClass.get(mem.classification) ?? [];
      existing.push(mem);
      byClass.set(mem.classification, existing);
    }
    
    for (const [classification, mems] of byClass) {
      for (const mem of mems) {
        const storeLabel = mem.store === 'ltm' ? '[LTM]' : '[STM]';
        lines.push(`- ${storeLabel} [${classification}] ${mem.summary}`);
      }
    }
    lines.push('');
  }
  
  // Project-level memories (specific to current project)
  if (projectLevel.length > 0) {
    const projectName = currentProject ? currentProject.split(/[/\\]/).pop() : 'Current Project';
    lines.push(`### ${projectName} Context`);
    lines.push('_These are specific to this project_');
    lines.push('');
    
    // Group by classification
    const byClass = new Map<string, MemoryUnit[]>();
    for (const mem of projectLevel) {
      const existing = byClass.get(mem.classification) ?? [];
      existing.push(mem);
      byClass.set(mem.classification, existing);
    }
    
    for (const [classification, mems] of byClass) {
      for (const mem of mems) {
        const storeLabel = mem.store === 'ltm' ? '[LTM]' : '[STM]';
        lines.push(`- ${storeLabel} [${classification}] ${mem.summary}`);
      }
    }
    lines.push('');
  }
  
  return lines.join('\n');
}

/**
 * Inject context into OpenCode session without triggering a response
 */
async function injectContext(
  state: OpenCodeAdapterState,
  sessionId: string,
  context: string
): Promise<void> {
  try {
    await state.client.session.prompt({
      path: { id: sessionId },
      body: {
        noReply: true,
        parts: [{ type: 'text', text: context }],
      },
    });
  } catch (error) {
    // Context injection is best-effort
    console.error('Failed to inject context:', error);
  }
}

/**
 * Handle compaction extraction - sweep ALL messages for memories before compaction
 * 
 * Unlike handleSessionIdle (incremental), this processes the ENTIRE conversation
 * because compaction will compress/summarize old messages and we'll lose the original content.
 */
async function handleCompactionExtraction(
  state: OpenCodeAdapterState,
  ctx: OpenCodePluginContext,
  sessionId: string
): Promise<{ memoriesCreated: number }> {
  debugLog(`handleCompactionExtraction: starting full sweep for session ${sessionId}`);
  
  // Fetch ALL messages for the session
  let messages: OpenCodeMessageContainer[];
  try {
    const response = await state.client.session.messages({
      path: { id: sessionId },
    });
    messages = response.data;
    debugLog(`Compaction sweep: fetched ${messages?.length ?? 0} total messages`);
  } catch (error) {
    debugLog(`Compaction sweep: failed to fetch messages: ${error}`);
    return { memoriesCreated: 0 };
  }
  
  if (!messages || messages.length === 0) {
    debugLog('Compaction sweep: no messages to process');
    return { memoriesCreated: 0 };
  }
  
  // Extract text from ALL messages (not incremental)
  const conversationText = extractConversationText(messages);
  
  if (!conversationText.trim()) {
    debugLog('Compaction sweep: no text content in messages');
    return { memoriesCreated: 0 };
  }
  
  debugLog(`Compaction sweep: extracted ${conversationText.length} chars from ${messages.length} messages`);
  
  // Process through Stop hook (extracts memories)
  // Note: We use 'compaction' reason to distinguish from normal 'user' turns
  const hookInput: HookInput = {
    hookType: 'Stop',
    sessionId,
    timestamp: new Date().toISOString(),
    data: {
      reason: 'compaction',
      conversationText,
      metadata: {
        messageCount: messages.length,
        agentType: 'opencode',
        isCompactionSweep: true,
      },
    } as StopData,
  };
  
  const result = await state.psychmem.handleHook(hookInput);
  
  // Note: We do NOT update the watermark here because:
  // 1. After compaction, the message indices will change
  // 2. We want the next session.idle to start fresh with the compacted context
  
  if (result.success) {
    const memoriesCreated = result.memoriesCreated ?? 0;
    debugLog(`Compaction sweep: created ${memoriesCreated} memories`);
    return { memoriesCreated };
  }
  
  debugLog('Compaction sweep: hook returned success=false');
  return { memoriesCreated: 0 };
}

/**
 * Build a custom compaction prompt that preserves PsychMem memories
 * 
 * This prompt REPLACES the default OpenCode compaction prompt,
 * giving us full control over what the LLM preserves.
 * 
 * Design principles:
 * 1. Preserve user-level memories (constraints, preferences) - HIGHEST priority
 * 2. Preserve project-level context (decisions, bugfixes)
 * 3. Keep critical conversation context (current task, recent actions)
 * 4. Discard verbose tool outputs, intermediate reasoning
 */
function buildCompactionPrompt(memoriesMarkdown: string | null): string {
  const sections: string[] = [];
  
  // Section 1: PsychMem memories (if any)
  if (memoriesMarkdown) {
    sections.push(memoriesMarkdown);
  }
  
  // Section 2: Instructions for the compaction LLM
  sections.push(`## Compaction Instructions

You are compacting a conversation that has grown too long. Your goal is to create a condensed summary that preserves all information needed to continue the task effectively.

### MUST PRESERVE (highest priority)
- The current task/goal the user is working on
- Any user constraints, preferences, or requirements stated
- Decisions made and their rationale
- Errors encountered and their solutions
- Files modified and why
- Current state of any in-progress work

### SHOULD PRESERVE (medium priority)  
- Key tool results that inform the current task
- Important paths, names, or identifiers mentioned
- Context about the codebase structure if relevant

### CAN DISCARD (safe to remove)
- Verbose tool outputs (file contents, search results) - summarize instead
- Intermediate reasoning that led to final decisions
- Exploratory discussions that didn't lead anywhere
- Repetitive information already captured above

### OUTPUT FORMAT
Write a clear, structured summary in markdown that a new instance of yourself could read and immediately understand:
1. What task is being worked on
2. What has been accomplished
3. What remains to be done
4. Any critical context (constraints, decisions, errors)

Do NOT include this instruction block in your output.`);

  return sections.join('\n\n');
}

/**
 * Log message through OpenCode's logging API
 */
function log(
  ctx: OpenCodePluginContext,
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  extra?: unknown
): void {
  try {
    if (ctx?.client?.app?.log) {
      ctx.client.app.log({
        body: {
          service: 'psychmem',
          level,
          message,
          extra,
        },
      }).catch(() => {});
    } else {
      debugLog(`[${level}] ${message}${extra ? ' ' + JSON.stringify(extra) : ''}`);
    }
  } catch (_) {
    debugLog(`[${level}] (log fallback) ${message}`);
  }
}

/**
 * OpenCode adapter class implementing PsychMemAdapter interface
 */
export class OpenCodeAdapter implements PsychMemAdapter {
  readonly agentType = 'opencode' as const;
  
  private state: OpenCodeAdapterState | null = null;
  private ctx: OpenCodePluginContext | null = null;
  
  async initialize(): Promise<void> {
    // Initialization happens in createOpenCodePlugin
    // This method is for interface compliance
  }
  
  /**
   * Set up adapter with OpenCode context
   */
  setup(ctx: OpenCodePluginContext, state: OpenCodeAdapterState): void {
    this.ctx = ctx;
    this.state = state;
  }
  
  async injectMemories(sessionId: string, memories: MemoryUnit[]): Promise<void> {
    if (!this.state) {
      throw new Error('OpenCode adapter not initialized');
    }
    
    const context = formatMemoriesForInjection(memories, 'session_start', this.state.worktree);
    await injectContext(this.state, sessionId, context);
  }
  
  getCurrentSessionId(): string | null {
    return this.state?.currentSessionId ?? null;
  }
  
  async cleanup(): Promise<void> {
    if (this.state) {
      this.state.psychmem.close();
      this.state = null;
    }
    this.ctx = null;
  }
}

/**
 * Default export for plugin loading
 */
export default createOpenCodePlugin;
