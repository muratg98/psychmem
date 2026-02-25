/**
 * PsychMem - Core Library Exports
 *
 * All public classes, types, utilities, and adapters are exported from here.
 * This file is used by programmatic consumers via `import { ... } from 'psychmem/core'`
 * and by internal modules that need the PsychMem class / utilities.
 *
 * The main entry point (`src/index.ts` / `dist/index.js`) intentionally only
 * exports the OpenCode Plugin function so that OpenCode's plugin loader
 * (which calls every export as a function) does not crash on class constructors
 * or other non-plugin exports.
 */

import { PsychMemHooks, createPsychMemHooks } from './hooks/index.js';
import { MemoryRetrieval } from './retrieval/index.js';
import { MemoryDatabase, createMemoryDatabase } from './storage/database.js';
import type { HookInput, PsychMemConfig, MemoryUnit } from './types/index.js';
import { DEFAULT_CONFIG } from './types/index.js';

export class PsychMem {
	private hooks!: PsychMemHooks;
	private retrieval!: MemoryRetrieval;
	private db!: MemoryDatabase;
	private config: PsychMemConfig;
	private initialized: boolean = false;
	private _externalDb?: MemoryDatabase;

	constructor(config: Partial<PsychMemConfig> = {}, db?: MemoryDatabase) {
		this.config = { ...DEFAULT_CONFIG, ...config };
		if (db) {
			this._externalDb = db;
		}
	}

	/**
	 * Initialize the PsychMem instance (must be called before use)
	 */
	async init(): Promise<void> {
		if (this.initialized) return;

		this.db = this._externalDb ?? await createMemoryDatabase(this.config);
		this.hooks = await createPsychMemHooks(this.config, this.db);
		this.retrieval = new MemoryRetrieval(this.db, this.config);
		this.initialized = true;
	}

	/**
	 * Ensure instance is initialized
	 */
	private ensureInit(): void {
		if (!this.initialized) {
			throw new Error('PsychMem not initialized. Call await psychmem.init() first.');
		}
	}

	/**
	 * Process a hook event
	 */
	async handleHook(input: HookInput) {
		this.ensureInit();
		return this.hooks.handle(input);
	}

	/**
	 * Search memories
	 */
	search(query: string, limit?: number) {
		this.ensureInit();
		return this.retrieval.search(query, undefined, limit);
	}

	/**
	 * Get memory by ID
	 */
	getMemory(id: string) {
		this.ensureInit();
		return this.retrieval.getMemory(id);
	}

	/**
	 * Get memory details for multiple IDs
	 */
	getMemories(ids: string[], sessionId?: string) {
		this.ensureInit();
		return this.retrieval.retrieveDetails(ids, sessionId);
	}

	/**
	 * Get memory stats
	 */
	getStats() {
		this.ensureInit();
		const stmActive = this.db.getMemoriesByStore('stm', 'active');
		const ltmActive = this.db.getMemoriesByStore('ltm', 'active');
		const stmDecayed = this.db.getMemoriesByStore('stm', 'decayed');
		const ltmDecayed = this.db.getMemoriesByStore('ltm', 'decayed');
		const stmPinned = this.db.getMemoriesByStore('stm', 'pinned');
		const ltmPinned = this.db.getMemoriesByStore('ltm', 'pinned');

		return {
			stm: {
				count: stmActive.length,
				decayedCount: stmDecayed.length,
				pinnedCount: stmPinned.length,
				avgStrength: this.avgStrength(stmActive),
			},
			ltm: {
				count: ltmActive.length,
				decayedCount: ltmDecayed.length,
				pinnedCount: ltmPinned.length,
				avgStrength: this.avgStrength(ltmActive),
			},
			total: stmActive.length + ltmActive.length,
			totalIncludingDecayed:
				stmActive.length + ltmActive.length +
				stmDecayed.length + ltmDecayed.length +
				stmPinned.length + ltmPinned.length,
		};
	}

	/**
	 * List memories, optionally filtered by store and/or status
	 */
	listMemories(options: { store?: 'stm' | 'ltm'; status?: 'active' | 'decayed' | 'pinned' | 'forgotten'; limit?: number } = {}) {
		this.ensureInit();
		const { store, status = 'active', limit = 50 } = options;
		if (store) {
			return this.db.getMemoriesByStore(store, status as any).slice(0, limit);
		}
		const stm = this.db.getMemoriesByStore('stm', status as any);
		const ltm = this.db.getMemoriesByStore('ltm', status as any);
		return [...ltm, ...stm]
			.sort((a, b) => b.strength - a.strength)
			.slice(0, limit);
	}

	/**
	 * Apply decay to all memories
	 */
	applyDecay() {
		this.ensureInit();
		return this.db.applyDecay();
	}

	/**
	 * Run consolidation
	 */
	runConsolidation() {
		this.ensureInit();
		return this.db.runConsolidation();
	}

	/**
	 * Pin a memory (prevent decay)
	 */
	pinMemory(id: string) {
		this.ensureInit();
		this.db.addFeedback('pin', id);
	}

	/**
	 * Forget a memory
	 */
	forgetMemory(id: string) {
		this.ensureInit();
		this.db.addFeedback('forget', id);
	}

	/**
	 * Remember a memory (boost importance + promote to LTM)
	 */
	rememberMemory(id: string) {
		this.ensureInit();
		this.db.addFeedback('remember', id);
	}

	/**
	 * Close database connection
	 */
	close() {
		if (this.initialized) {
			// Only close db here — hooks shares the same db instance,
			// so calling hooks.close() would double-close and throw
			this.db.close();
		}
	}

	private avgStrength(memories: MemoryUnit[]): number {
		if (memories.length === 0) return 0;
		return memories.reduce((sum, m) => sum + m.strength, 0) / memories.length;
	}
}

/**
 * Create and initialize a PsychMem instance
 */
export async function createPsychMem(config: Partial<PsychMemConfig> = {}, db?: MemoryDatabase): Promise<PsychMem> {
	const psychmem = new PsychMem(config, db);
	await psychmem.init();
	return psychmem;
}

// Re-export types and utilities
export * from './types/index.js';
export { PsychMemHooks, createPsychMemHooks } from './hooks/index.js';
export { MemoryRetrieval } from './retrieval/index.js';
export { MemoryDatabase, createMemoryDatabase } from './storage/database.js';
export { ContextSweep } from './memory/context-sweep.js';
export { SelectiveMemory } from './memory/selective-memory.js';

// Re-export adapter types (excluding AgentType which is in types/index.js)
export type {
	OpenCodePluginContext,
	OpenCodeClient,
	OpenCodeSession,
	OpenCodeMessageContainer,
	OpenCodeMessageInfo,
	OpenCodeMessagePart,
	OpenCodeEvent,
	OpenCodePluginHooks,
	OpenCodePlugin,
	BunShell,
	PsychMemAdapter,
	AdapterOptions,
} from './adapters/types.js';

// Re-export adapters
export { createOpenCodePlugin, OpenCodeAdapter } from './adapters/opencode/index.js';
