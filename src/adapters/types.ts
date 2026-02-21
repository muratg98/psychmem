/**
 * PsychMem Adapter Types
 * Common interfaces for agent-specific adapters
 */

import type { MemoryUnit, AgentType } from '../types/index.js';

// =============================================================================
// OpenCode Types (from @opencode-ai/plugin)
// =============================================================================

/**
 * OpenCode plugin context provided to plugin functions
 */
export interface OpenCodePluginContext {
  /** Current project information */
  project: unknown;
  /** Current working directory */
  directory: string;
  /** Git worktree root path */
  worktree: string;
  /** OpenCode SDK client */
  client: OpenCodeClient;
  /** Bun shell API */
  $: BunShell;
}

/**
 * Bun shell API (subset we use)
 */
export interface BunShell {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<{ text(): string }>;
}

/**
 * OpenCode SDK client interface (subset we use)
 */
export interface OpenCodeClient {
  session: {
    /** Get all messages in a session */
    messages(params: { path: { id: string } }): Promise<{ data: OpenCodeMessageContainer[] }>;
    
    /** Send a prompt to a session */
    prompt(params: {
      path: { id: string };
      body: {
        noReply?: boolean;
        parts: Array<{ type: 'text'; text: string }>;
      };
    }): Promise<unknown>;
    
    /** Get session details */
    get(params: { path: { id: string } }): Promise<{ data: OpenCodeSession }>;
  };
  
  app: {
    /** Write a log entry */
    log(params: {
      body: {
        service: string;
        level: 'debug' | 'info' | 'warn' | 'error';
        message: string;
        extra?: unknown;
      };
    }): Promise<void>;
  };
}

/**
 * OpenCode session details
 */
export interface OpenCodeSession {
  id: string;
  title?: string;
  created: string;
  updated: string;
}

/**
 * OpenCode message container (info + parts)
 * Shape returned by client.session.messages()
 */
export interface OpenCodeMessageContainer {
  info: OpenCodeMessageInfo;
  parts: OpenCodeMessagePart[];
}

/**
 * OpenCode message info (UserMessage | AssistantMessage from SDK)
 */
export interface OpenCodeMessageInfo {
  id: string;
  sessionID: string;
  role: 'user' | 'assistant';
  time: {
    created: number;
    completed?: number;
  };
}

/**
 * OpenCode message part (Part from SDK)
 * Most relevant types:
 *   - text:  { type: 'text', text: string }
 *   - tool:  { type: 'tool', tool: string, state: ToolState }
 */
export interface OpenCodeMessagePart {
  type: 'text' | 'tool' | string;
  /** Present on type='text' */
  text?: string;
  /** Present on type='tool' */
  tool?: string;
  /** Present on type='tool', contains input/output/error */
  state?: OpenCodeToolState;
}

/**
 * Tool state (completed or error)
 */
export interface OpenCodeToolState {
  status: 'pending' | 'running' | 'completed' | 'error';
  /** Present when status='completed' */
  output?: string;
  /** Present when status='completed' */
  title?: string;
  /** Present when status='error' */
  error?: string;
  /** Input arguments (present when status='completed' or 'error') */
  input?: Record<string, unknown>;
}

/**
 * OpenCode event from event subscription
 * 
 * SDK event shapes:
 * - session.created → { type, properties: { info: Session } }
 * - session.idle    → { type, properties: { sessionID: string } }
 * - session.deleted → { type, properties: { info: Session } }
 * - session.error   → { type, properties: { sessionID?: string, error?: ... } }
 */
export interface OpenCodeEvent {
  type: string;
  properties?: Record<string, unknown>;
}

/**
 * OpenCode tool.execute.after input shape (from SDK)
 */
export interface OpenCodeToolInput {
  tool: string;
  sessionID: string;
  callID: string;
  args: unknown;
}

/**
 * OpenCode tool.execute.after output shape (from SDK)
 */
export interface OpenCodeToolOutput {
  title: string;
  output: string;
  metadata: unknown;
}

/**
 * OpenCode compaction hook input shape
 * Note: The input may not contain session messages directly,
 * so we fetch them via client.session.messages()
 */
export interface OpenCodeCompactionInput {
  /** Session ID being compacted */
  sessionID?: string;
  /** Any additional properties */
  [key: string]: unknown;
}

/**
 * OpenCode message.updated event properties
 * SDK shape: { type: 'message.updated', properties: { info: Message } }
 * Message has sessionID on info directly.
 */
export interface OpenCodeMessageUpdatedEvent {
  /** The message info (UserMessage | AssistantMessage) */
  info?: {
    id?: string;
    sessionID?: string;
    role?: 'user' | 'assistant';
  };
  /** Fallback: some older SDK versions put sessionID at top level */
  sessionID?: string;
  /** Message ID (legacy, may not be present) */
  messageID?: string;
  /** Role of the message sender (legacy) */
  role?: 'user' | 'assistant';
}

/**
 * OpenCode plugin hook return type
 */
export interface OpenCodePluginHooks {
  /** Event handler for session lifecycle events */
  event?: (params: { event: OpenCodeEvent }) => Promise<void>;
  
  /** Hook before tool execution */
  'tool.execute.before'?: (
    input: { tool: string; args: unknown },
    output: { args: unknown }
  ) => Promise<void>;
  
  /** Hook after tool execution */
  'tool.execute.after'?: (
    input: OpenCodeToolInput,
    output: OpenCodeToolOutput
  ) => Promise<void>;
  
  /** Hook for shell environment */
  'shell.env'?: (
    input: { cwd: string },
    output: { env: Record<string, string> }
  ) => Promise<void>;
  
  /** Experimental: Hook for session compaction */
  'experimental.session.compacting'?: (
    input: OpenCodeCompactionInput,
    output: { context: string[]; prompt?: string }
  ) => Promise<void>;
  
  /** Custom tools */
  tool?: Record<string, unknown>;
}

/**
 * OpenCode plugin function type
 */
export type OpenCodePlugin = (ctx: OpenCodePluginContext) => Promise<OpenCodePluginHooks>;

// =============================================================================
// Common Adapter Interface
// =============================================================================

/**
 * Common adapter interface for all AI agents
 */
export interface PsychMemAdapter {
  /** Agent type identifier */
  readonly agentType: AgentType;
  
  /** Initialize adapter and connect to agent */
  initialize(): Promise<void>;
  
  /** Inject memories into agent context */
  injectMemories(sessionId: string, memories: MemoryUnit[]): Promise<void>;
  
  /** Get current session ID */
  getCurrentSessionId(): string | null;
  
  /** Cleanup on shutdown */
  cleanup(): Promise<void>;
}

/**
 * Options for creating an adapter
 */
export interface AdapterOptions {
  /** Override default config */
  config?: Record<string, unknown>;
}
