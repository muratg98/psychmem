/**
 * PsychMem Plugin for OpenCode
 * 
 * Psych-grounded selective memory system that enables persistent memory
 * across sessions with human-like memory consolidation.
 * 
 * Features:
 * - Automatic memory extraction from conversations
 * - STM/LTM consolidation with decay curves
 * - Memory injection on session start and compaction
 * - Compaction sweep: extracts memories before context compression
 * - Per-message extraction: real-time memory capture (v1.9)
 * - Incremental processing with message watermarking
 * 
 * Configuration (via environment variables):
 * - PSYCHMEM_INJECT_ON_COMPACTION: Enable memory injection during compaction (default: true)
 * - PSYCHMEM_EXTRACT_ON_COMPACTION: Enable memory extraction during compaction (default: true)
 * - PSYCHMEM_EXTRACT_ON_MESSAGE: Enable per-message memory extraction (default: true)
 * - PSYCHMEM_MAX_COMPACTION_MEMORIES: Max memories to inject on compaction (default: 10)
 * - PSYCHMEM_MAX_SESSION_MEMORIES: Max memories to inject on session start (default: 10)
 * - PSYCHMEM_MESSAGE_WINDOW_SIZE: Number of recent messages for context (default: 3)
 * - PSYCHMEM_MESSAGE_IMPORTANCE_THRESHOLD: Min importance for per-message extraction (default: 0.5)
 */

// Use compiled dist files (works better with Bun's module resolution)
import type { OpenCodePluginContext, OpenCodePluginHooks } from '../../dist/adapters/types.js';
import { createOpenCodePlugin } from '../../dist/adapters/opencode/index.js';
import type { PsychMemConfig } from '../../dist/types/index.js';

/**
 * Parse boolean environment variable
 */
function parseEnvBool(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  return value.toLowerCase() === 'true' || value === '1';
}

/**
 * Parse number environment variable
 */
function parseEnvNumber(value: string | undefined, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Parse float environment variable
 */
function parseEnvFloat(value: string | undefined, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  const parsed = parseFloat(value);
  return isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Plugin entry point - named export as required by OpenCode
 */
export const PsychMemPlugin = async (ctx: OpenCodePluginContext): Promise<OpenCodePluginHooks> => {
  console.log('[PsychMem] Initializing plugin...');
  
  // Load configuration from environment
  const config: Partial<PsychMemConfig> = {
    opencode: {
      injectOnCompaction: parseEnvBool(
        process.env.PSYCHMEM_INJECT_ON_COMPACTION,
        true
      ),
      extractOnCompaction: parseEnvBool(
        process.env.PSYCHMEM_EXTRACT_ON_COMPACTION,
        true
      ),
      extractOnUserMessage: parseEnvBool(
        process.env.PSYCHMEM_EXTRACT_ON_MESSAGE,
        true
      ),
      maxCompactionMemories: parseEnvNumber(
        process.env.PSYCHMEM_MAX_COMPACTION_MEMORIES,
        10
      ),
      maxSessionStartMemories: parseEnvNumber(
        process.env.PSYCHMEM_MAX_SESSION_MEMORIES,
        10
      ),
      messageWindowSize: parseEnvNumber(
        process.env.PSYCHMEM_MESSAGE_WINDOW_SIZE,
        3
      ),
      messageImportanceThreshold: parseEnvFloat(
        process.env.PSYCHMEM_MESSAGE_IMPORTANCE_THRESHOLD,
        0.5
      ),
    },
  };
  
  try {
    const hooks = await createOpenCodePlugin(ctx, config);
    console.log('[PsychMem] Plugin initialized successfully');
    console.log('[PsychMem] Per-message extraction:', config.opencode?.extractOnUserMessage ? 'enabled' : 'disabled');
    return hooks;
  } catch (error) {
    console.error('[PsychMem] Failed to initialize:', error);
    throw error;
  }
};
