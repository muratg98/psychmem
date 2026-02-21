/**
 * PsychMem OpenCode Plugin
 *
 * Entry point for OpenCode's plugin system when installed via npm.
 *
 * Add to opencode.json:
 * {
 *   "plugin": ["psychmem"]
 * }
 */

import { createOpenCodePlugin } from 'psychmem/adapters/opencode';

function parseEnvBool(value, defaultValue) {
  if (value === undefined) return defaultValue;
  return value.toLowerCase() === 'true' || value === '1';
}

function parseEnvNumber(value, defaultValue) {
  if (value === undefined) return defaultValue;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

function parseEnvFloat(value, defaultValue) {
  if (value === undefined) return defaultValue;
  const parsed = parseFloat(value);
  return isNaN(parsed) ? defaultValue : parsed;
}

export const PsychMem = async (ctx) => {
  const config = {
    opencode: {
      injectOnCompaction: parseEnvBool(process.env.PSYCHMEM_INJECT_ON_COMPACTION, true),
      extractOnCompaction: parseEnvBool(process.env.PSYCHMEM_EXTRACT_ON_COMPACTION, true),
      extractOnMessage: parseEnvBool(process.env.PSYCHMEM_EXTRACT_ON_MESSAGE, true),
      maxCompactionMemories: parseEnvNumber(process.env.PSYCHMEM_MAX_COMPACTION_MEMORIES, 10),
      maxSessionStartMemories: parseEnvNumber(process.env.PSYCHMEM_MAX_SESSION_MEMORIES, 10),
      messageWindowSize: parseEnvNumber(process.env.PSYCHMEM_MESSAGE_WINDOW_SIZE, 3),
      messageImportanceThreshold: parseEnvFloat(process.env.PSYCHMEM_MESSAGE_IMPORTANCE_THRESHOLD, 0.5),
    },
  };

  return await createOpenCodePlugin(ctx, config);
};
