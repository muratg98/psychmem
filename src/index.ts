/**
 * PsychMem — OpenCode Plugin Entry Point
 *
 * This file is the main entry point (`"."` in package.json exports).
 * It ONLY exports Plugin-typed functions so that OpenCode's plugin loader
 * — which calls `Object.entries(mod)` and invokes every export as a function —
 * does not crash on class constructors, constants, or utility exports.
 *
 * For the full library API (PsychMem class, adapters, types, etc.) use:
 *   import { PsychMem, ... } from 'psychmem/core';
 */

import { createOpenCodePlugin, parsePluginConfig } from './adapters/opencode/index.js';
import type { OpenCodePluginContext, OpenCodePluginHooks } from './adapters/types.js';

/**
 * Named export — OpenCode plugin function.
 *
 * OpenCode iterates `Object.entries(mod)` and calls each export as
 * `value(ctx)`, so every named export in this file MUST be an async
 * function that accepts `OpenCodePluginContext` and returns hooks.
 */
export async function PsychMemPlugin(
	ctx: OpenCodePluginContext
): Promise<OpenCodePluginHooks> {
	return createOpenCodePlugin(ctx, parsePluginConfig());
}

/**
 * Default export — same plugin function.
 *
 * Kept for compatibility with loaders that use `import mod` and call
 * `mod.default(ctx)`.
 */
export default PsychMemPlugin;
