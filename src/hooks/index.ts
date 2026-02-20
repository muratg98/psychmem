/**
 * PsychMem Hooks - Entry point for agent hook integration
 * 
 * Handles all hook types:
 * - SessionStart: Load relevant memories into context
 * - UserPromptSubmit: Capture user input (delegated to PostToolUse)
 * - PostToolUse: Capture tool events for memory extraction
 * - Stop: Process session and extract memories
 * - SessionEnd: Run consolidation and cleanup
 */

import type {
  HookInput,
  HookOutput,
  HookType,
  SessionStartData,
  UserPromptSubmitData,
  PostToolUseData,
  StopData,
  SessionEndData,
  PsychMemConfig,
} from '../types/index.js';
import { DEFAULT_CONFIG } from '../types/index.js';
import { MemoryDatabase, createMemoryDatabase } from '../storage/database.js';
import { SessionStartHook } from './session-start.js';
import { PostToolUseHook } from './post-tool-use.js';
import { StopHook } from './stop.js';
import { SessionEndHook } from './session-end.js';
import { MemoryRetrieval } from '../retrieval/index.js';

export class PsychMemHooks {
  private db!: MemoryDatabase;
  private config: PsychMemConfig;
  private initialized: boolean = false;
  
  // Hook handlers
  private sessionStartHook!: SessionStartHook;
  private postToolUseHook!: PostToolUseHook;
  private stopHook!: StopHook;
  private sessionEndHook!: SessionEndHook;
  private retrieval!: MemoryRetrieval;
  
  // Current session tracking (in-memory, for single-process usage)
  private currentSessionId: string | null = null;
  
  // Map external session IDs to internal session IDs
  private sessionMap: Map<string, string> = new Map();

  constructor(config: Partial<PsychMemConfig> = {}, db?: MemoryDatabase) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    if (db) {
      this.db = db;
    }
  }
  
  /**
   * Initialize hooks (must be called before use)
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    
    if (!this.db) {
      this.db = await createMemoryDatabase(this.config);
    }
    
    // Initialize hook handlers
    this.sessionStartHook = new SessionStartHook(this.db, this.config);
    this.postToolUseHook = new PostToolUseHook(this.db, this.config);
    this.stopHook = new StopHook(this.db, this.config);
    this.sessionEndHook = new SessionEndHook(this.db, this.config);
    this.retrieval = new MemoryRetrieval(this.db, this.config);
    
    // Load active sessions from DB for CLI persistence
    this.loadActiveSessions();
    
    this.initialized = true;
  }
  
  /**
   * Ensure instance is initialized
   */
  private ensureInit(): void {
    if (!this.initialized) {
      throw new Error('PsychMemHooks not initialized. Call await hooks.init() first.');
    }
  }
  
  /**
   * Load active sessions from DB to support CLI mode (separate process per call)
   */
  private loadActiveSessions(): void {
    // Note: Called from init(), db is guaranteed to be ready
    const activeSessions = this.db.getActiveSessions();
    for (const session of activeSessions) {
      // Use the session ID itself as the external ID if no external mapping stored
      const externalId = (session.metadata as Record<string, unknown> | undefined)?.externalSessionId;
      if (typeof externalId === 'string') {
        this.sessionMap.set(externalId, session.id);
      }
    }
  }
  
  /**
   * Resolve session ID - use external ID from input if available
   */
  private resolveSessionId(input: HookInput): string | null {
    // If input has a sessionId, use it to look up or track the session
    if (input.sessionId) {
      const internalId = this.sessionMap.get(input.sessionId);
      if (internalId) {
        return internalId;
      }
    }
    // Fall back to in-memory current session
    return this.currentSessionId;
  }

  /**
   * Main hook handler - dispatches to appropriate handler based on hook type
   */
  async handle(input: HookInput): Promise<HookOutput> {
    this.ensureInit();
    try {
      switch (input.hookType) {
        case 'SessionStart':
          return this.handleSessionStart(input);
        
        case 'UserPromptSubmit':
          return this.handleUserPromptSubmit(input);
        
        case 'PostToolUse':
          return this.handlePostToolUse(input);
        
        case 'Stop':
          return this.handleStop(input);
        
        case 'SessionEnd':
          return this.handleSessionEnd(input);
        
        default:
          return { success: false, error: `Unknown hook type: ${input.hookType}` };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: message };
    }
  }

  /**
   * SessionStart: Create session and retrieve relevant memories
   */
  private handleSessionStart(input: HookInput): HookOutput {
    const data = input.data as SessionStartData;
    
    // Extract transcriptPath from metadata if provided
    const transcriptPath = (data.metadata as Record<string, unknown> | undefined)?.transcriptPath as string | undefined;
    
    // Create new session with external ID mapping and transcript path
    const session = this.db.createSession(
      data.project, 
      {
        workingDirectory: data.workingDirectory,
        externalSessionId: input.sessionId, // Store external ID for CLI persistence
        ...data.metadata,
      },
      transcriptPath
    );
    this.currentSessionId = session.id;
    
    // Map external to internal ID
    if (input.sessionId) {
      this.sessionMap.set(input.sessionId, session.id);
    }
    
    // Retrieve and format relevant memories
    const context = this.sessionStartHook.generateContext(data.project, data.workingDirectory);
    
    return {
      success: true,
      context,
    };
  }

  /**
   * UserPromptSubmit: Capture user input; inject relevant memories for questions.
   *
   * If the prompt looks like a question or references past context
   * (e.g. "what port…", "do you remember…", "we decided…"), we run a
   * scoped memory search and inject up to 3 matching memories so the
   * assistant can answer without waiting for the next SessionStart.
   */
  private handleUserPromptSubmit(input: HookInput): HookOutput {
    const sessionId = this.resolveSessionId(input);
    if (!sessionId) {
      return { success: false, error: 'No active session' };
    }
    
    const data = input.data as UserPromptSubmitData;
    
    // Store the event for later processing
    this.db.createEvent(
      sessionId,
      'UserPromptSubmit',
      data.prompt,
      data.metadata ? { metadata: data.metadata } : undefined
    );

    // --- Query-time retrieval ---
    if (this.isQuestion(data.prompt)) {
      const currentProject = (data.metadata as Record<string, unknown> | undefined)?.project as string | undefined;
      const hits = this.retrieval.searchByScope(data.prompt, {
        ...(currentProject !== undefined ? { currentProject } : {}),
        limit: 3,
      });

      if (hits.length > 0) {
        const lines: string[] = ['## Relevant Memories (query-time retrieval)'];
        for (const item of hits) {
          lines.push(`- [${item.classification}] ${item.summary}`);
        }
        return { success: true, context: lines.join('\n') };
      }
    }

    return { success: true };
  }

  /**
   * Heuristic: decide whether a prompt is a question that warrants
   * checking memory before the assistant replies.
   */
  private isQuestion(prompt: string): boolean {
    const lower = prompt.toLowerCase().trim();

    // Ends with a question mark
    if (lower.endsWith('?')) return true;

    // Starts with a question word
    const questionStarters = /^(what|how|why|where|when|which|who|did|do|does|can|could|should|would|is|are|was|were)\b/;
    if (questionStarters.test(lower)) return true;

    // References past context explicitly
    const memoryRefs = /(remember|recall|we decided|you said|previously|last time|before|earlier|port|config|setting|command|password|key|token|url|endpoint)/;
    if (memoryRefs.test(lower)) return true;

    return false;
  }

  /**
   * PostToolUse: Capture tool execution for memory extraction
   */
  private handlePostToolUse(input: HookInput): HookOutput {
    let sessionId = this.resolveSessionId(input);
    
    // Auto-create session if SessionStart was missed
    if (!sessionId && input.sessionId) {
      const session = this.db.createSession('', {
        externalSessionId: input.sessionId,
        metadata: { autoCreated: true, reason: 'post-tool-use-without-session-start' },
      });
      this.currentSessionId = session.id;
      this.sessionMap.set(input.sessionId, session.id);
      sessionId = session.id;
    }
    
    if (!sessionId) {
      return { success: false, error: 'No active session' };
    }
    
    const data = input.data as PostToolUseData;
    
    // Capture the tool event
    this.postToolUseHook.capture(sessionId, data);
    
    return { success: true };
  }

  /**
   * Stop: Process session events and extract memories
   */
  private async handleStop(input: HookInput): Promise<HookOutput> {
    let sessionId = this.resolveSessionId(input);
    
    // Auto-create session if SessionStart was missed (e.g. plugin restarted mid-session)
    if (!sessionId && input.sessionId) {
      const data = input.data as StopData;
      const project = (data.metadata as Record<string, unknown> | undefined)?.project as string | undefined ?? '';
      const session = this.db.createSession(project, {
        externalSessionId: input.sessionId,
        metadata: { autoCreated: true, reason: 'stop-without-session-start' },
      });
      this.currentSessionId = session.id;
      this.sessionMap.set(input.sessionId, session.id);
      sessionId = session.id;
    }
    
    if (!sessionId) {
      return { success: false, error: 'No active session' };
    }
    
    const data = input.data as StopData;
    
    // Process the session and extract memories (async for transcript parsing)
    const result = await this.stopHook.process(sessionId, data);
    
    // Build context summary with transcript stats if available
    let contextSummary = result.summary;
    if (result.transcriptStats) {
      contextSummary += `\n\n[Transcript: ${result.transcriptStats.rawCandidates} raw → ${result.transcriptStats.afterDedup} after dedup → ${result.memoriesCreated} stored]`;
    }
    
    return {
      success: true,
      context: contextSummary,
      memoriesCreated: result.memoriesCreated,
    };
  }

  /**
   * SessionEnd: Run consolidation and cleanup
   */
  private handleSessionEnd(input: HookInput): HookOutput {
    const sessionId = this.resolveSessionId(input);
    if (!sessionId) {
      return { success: false, error: 'No active session' };
    }
    
    const data = input.data as SessionEndData;
    
    // Run consolidation and end session
    const result = this.sessionEndHook.process(sessionId, data);
    
    // Clear session tracking
    if (input.sessionId) {
      this.sessionMap.delete(input.sessionId);
    }
    if (this.currentSessionId === sessionId) {
      this.currentSessionId = null;
    }
    
    return {
      success: true,
      context: `Session ended. Promoted ${result.promoted} memories to LTM, decayed ${result.decayed}.`,
    };
  }

  /**
   * Get the current session ID
   */
  getSessionId(): string | null {
    return this.currentSessionId;
  }

  /**
   * Close database connection
   */
  close(): void {
    if (this.initialized) {
      this.db.close();
    }
  }
}

/**
 * Create and initialize a PsychMemHooks instance
 */
export async function createPsychMemHooks(config: Partial<PsychMemConfig> = {}, db?: MemoryDatabase): Promise<PsychMemHooks> {
  const hooks = new PsychMemHooks(config, db);
  await hooks.init();
  return hooks;
}

// Export individual hooks for direct use if needed
export { SessionStartHook } from './session-start.js';
export { PostToolUseHook } from './post-tool-use.js';
export { StopHook } from './stop.js';
export { SessionEndHook } from './session-end.js';
