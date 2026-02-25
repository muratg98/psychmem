/**
 * PsychMem local development plugin for OpenCode.
 *
 * Loads from the compiled dist/ directory so local changes are reflected
 * after `npm run build`. This file is loaded by OpenCode from
 * .opencode/plugins/ automatically at startup.
 *
 * To test local changes:
 *   npm run build          # recompile src/ → dist/
 *   (restart OpenCode)     # picks up the new dist/
 */
import { createOpenCodePlugin, parsePluginConfig } from '../../dist/adapters/opencode/index.js';

export const PsychMem = async (ctx) => {
  return await createOpenCodePlugin(ctx, parsePluginConfig());
};
