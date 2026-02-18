/**
 * PsychMem Database Layer
 * SQLite with runtime-agnostic adapter (supports Node.js + Bun)
 */

import { v4 as uuidv4 } from 'uuid';
import type {
  Session,
  Event,
  MemoryUnit,
  MemoryEvidence,
  RetrievalLog,
  Feedback,
  MemoryStore,
  MemoryClassification,
  MemoryStatus,
  HookType,
  PsychMemConfig,
} from '../types/index.js';
import { DEFAULT_CONFIG } from '../types/index.js';
import { resolveDbPath } from '../utils/paths.js';
import { createDatabase, loadVecExtension, isBun, type SqliteDatabase } from './sqlite-adapter.js';

export class MemoryDatabase {
  private db!: SqliteDatabase;
  private config: PsychMemConfig;
  private vecEnabled: boolean = false;
  private initialized: boolean = false;

  constructor(config: Partial<PsychMemConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Initialize database (must be called before use)
   * For sync compatibility, also auto-initializes on first use
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    
    const dbPath = resolveDbPath(this.config.dbPath, this.config.agentType);
    this.db = await createDatabase(dbPath);
    
    // Set WAL mode
    this.db.exec('PRAGMA journal_mode = WAL');
    
    // Try to load vector extension (Node.js only)
    this.vecEnabled = await loadVecExtension(this.db);
    
    this.initializeSchema();
    this.initialized = true;
  }

  /**
   * Ensure database is initialized (for backwards compatibility)
   */
  private ensureInit(): void {
    if (!this.initialized) {
      throw new Error('Database not initialized. Call await db.init() first.');
    }
  }

  /**
   * Initialize database schema
   */
  private initializeSchema(): void {
    // First, create base tables (without project_scope index)
    this.db.exec(`
      -- Sessions table
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        metadata TEXT,
        transcript_path TEXT,
        transcript_watermark INTEGER DEFAULT 0,
        message_watermark INTEGER DEFAULT 0
      );

      -- Events table (raw hook events)
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        hook_type TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_name TEXT,
        tool_input TEXT,
        tool_output TEXT,
        metadata TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );

      -- Memory units table (consolidated memories)
      CREATE TABLE IF NOT EXISTS memory_units (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        store TEXT NOT NULL,
        classification TEXT NOT NULL,
        summary TEXT NOT NULL,
        source_event_ids TEXT NOT NULL,
        project_scope TEXT,
        
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_accessed_at TEXT NOT NULL,
        
        recency REAL NOT NULL DEFAULT 0,
        frequency INTEGER NOT NULL DEFAULT 1,
        importance REAL NOT NULL DEFAULT 0.5,
        utility REAL NOT NULL DEFAULT 0.5,
        novelty REAL NOT NULL DEFAULT 0.5,
        confidence REAL NOT NULL DEFAULT 0.5,
        interference REAL NOT NULL DEFAULT 0,
        
        strength REAL NOT NULL DEFAULT 0.5,
        decay_rate REAL NOT NULL,
        
        tags TEXT,
        associations TEXT,
        
        status TEXT NOT NULL DEFAULT 'active',
        version INTEGER NOT NULL DEFAULT 1,
        
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );

      -- Memory evidence table
      CREATE TABLE IF NOT EXISTS memory_evidence (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        contribution TEXT,
        confidence_delta REAL DEFAULT 0,
        FOREIGN KEY (memory_id) REFERENCES memory_units(id),
        FOREIGN KEY (event_id) REFERENCES events(id)
      );

      -- Retrieval logs for feedback learning
      CREATE TABLE IF NOT EXISTS retrieval_logs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        memory_id TEXT NOT NULL,
        query TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        was_used INTEGER NOT NULL DEFAULT 0,
        user_feedback TEXT,
        relevance_score REAL NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id),
        FOREIGN KEY (memory_id) REFERENCES memory_units(id)
      );

      -- User feedback table
      CREATE TABLE IF NOT EXISTS feedback (
        id TEXT PRIMARY KEY,
        memory_id TEXT,
        type TEXT NOT NULL,
        content TEXT,
        timestamp TEXT NOT NULL,
        FOREIGN KEY (memory_id) REFERENCES memory_units(id)
      );

      -- Indexes for performance (excluding project_scope - added after migration)
      CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
      CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_memory_store ON memory_units(store);
      CREATE INDEX IF NOT EXISTS idx_memory_status ON memory_units(status);
      CREATE INDEX IF NOT EXISTS idx_memory_strength ON memory_units(strength);
      CREATE INDEX IF NOT EXISTS idx_memory_classification ON memory_units(classification);
      CREATE INDEX IF NOT EXISTS idx_memory_session ON memory_units(session_id);
      CREATE INDEX IF NOT EXISTS idx_retrieval_session ON retrieval_logs(session_id);
    `);

    // Migration: Add project_scope column if it doesn't exist (for existing DBs pre-v1.6)
    // MUST run before creating index on project_scope
    this.migrateProjectScope();
    
    // Now safe to create index on project_scope (column guaranteed to exist)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memory_project_scope ON memory_units(project_scope);
    `);

    // Create vector table only if vec extension is loaded
    if (this.vecEnabled) {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_embeddings USING vec0(
          memory_id TEXT PRIMARY KEY,
          embedding FLOAT[${this.config.embeddingDimension}]
        );
      `);
    }
  }

  /**
   * Migration: Add project_scope column to existing databases
   */
  private migrateProjectScope(): void {
    // Check if column exists
    const tableInfo = this.db.prepare(`PRAGMA table_info(memory_units)`).all() as any[];
    const hasProjectScope = tableInfo.some(col => col.name === 'project_scope');
    
    if (!hasProjectScope) {
      this.db.exec(`ALTER TABLE memory_units ADD COLUMN project_scope TEXT`);
    }
  }

  // ===========================================================================
  // Session Operations
  // ===========================================================================

  createSession(project: string, metadata?: Record<string, unknown>, transcriptPath?: string): Session {
    this.ensureInit();
    
    const session: Session = {
      id: uuidv4(),
      project,
      startedAt: new Date(),
      status: 'active',
      metadata,
      transcriptPath,
      transcriptWatermark: 0,
      messageWatermark: 0,
    };

    this.db.prepare(`
      INSERT INTO sessions (id, project, started_at, status, metadata, transcript_path, transcript_watermark, message_watermark)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      session.id,
      session.project,
      session.startedAt.toISOString(),
      session.status,
      metadata ? JSON.stringify(metadata) : null,
      transcriptPath ?? null,
      0,
      0
    );

    return session;
  }

  endSession(sessionId: string, status: 'completed' | 'abandoned' = 'completed'): void {
    this.ensureInit();
    this.db.prepare(`
      UPDATE sessions SET ended_at = ?, status = ? WHERE id = ?
    `).run(new Date().toISOString(), status, sessionId);
  }

  getSession(sessionId: string): Session | null {
    this.ensureInit();
    const row = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(sessionId) as any;
    if (!row) return null;
    return this.rowToSession(row);
  }

  getActiveSessions(): Session[] {
    this.ensureInit();
    const rows = this.db.prepare(`SELECT * FROM sessions WHERE status = 'active'`).all() as any[];
    return rows.map(row => this.rowToSession(row));
  }

  /**
   * Get the current transcript watermark (byte offset) for a session
   */
  getSessionWatermark(sessionId: string): number {
    this.ensureInit();
    const row = this.db.prepare(`
      SELECT transcript_watermark FROM sessions WHERE id = ?
    `).get(sessionId) as any;
    return row?.transcript_watermark ?? 0;
  }

  /**
   * Update the transcript watermark (byte offset) for a session
   */
  updateSessionWatermark(sessionId: string, watermark: number): void {
    this.ensureInit();
    this.db.prepare(`
      UPDATE sessions SET transcript_watermark = ? WHERE id = ?
    `).run(watermark, sessionId);
  }

  /**
   * Get the current message watermark (message index) for a session
   * Used by OpenCode adapter to track which messages have been processed
   */
  getMessageWatermark(sessionId: string): number {
    this.ensureInit();
    const row = this.db.prepare(`
      SELECT message_watermark FROM sessions WHERE id = ?
    `).get(sessionId) as any;
    return row?.message_watermark ?? 0;
  }

  /**
   * Update the message watermark (message index) for a session
   * Used by OpenCode adapter to mark messages as processed
   */
  updateMessageWatermark(sessionId: string, watermark: number): void {
    this.ensureInit();
    this.db.prepare(`
      UPDATE sessions SET message_watermark = ? WHERE id = ?
    `).run(watermark, sessionId);
  }

  /**
   * Get all memories for a specific session (for deduplication)
   */
  getSessionMemories(sessionId: string, status: MemoryStatus = 'active'): MemoryUnit[] {
    this.ensureInit();
    const rows = this.db.prepare(`
      SELECT * FROM memory_units 
      WHERE session_id = ? AND status = ?
      ORDER BY created_at DESC
    `).all(sessionId, status) as any[];
    return rows.map(this.rowToMemoryUnit.bind(this));
  }

  // ===========================================================================
  // Event Operations
  // ===========================================================================

  createEvent(
    sessionId: string,
    hookType: HookType,
    content: string,
    options?: {
      toolName?: string;
      toolInput?: string;
      toolOutput?: string;
      metadata?: Record<string, unknown>;
    }
  ): Event {
    this.ensureInit();
    
    const event: Event = {
      id: uuidv4(),
      sessionId,
      hookType,
      timestamp: new Date(),
      content,
      toolName: options?.toolName,
      toolInput: options?.toolInput,
      toolOutput: options?.toolOutput,
      metadata: options?.metadata,
    };

    this.db.prepare(`
      INSERT INTO events (id, session_id, hook_type, timestamp, content, tool_name, tool_input, tool_output, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.sessionId,
      event.hookType,
      event.timestamp.toISOString(),
      event.content,
      event.toolName ?? null,
      event.toolInput ?? null,
      event.toolOutput ?? null,
      event.metadata ? JSON.stringify(event.metadata) : null
    );

    return event;
  }

  getSessionEvents(sessionId: string): Event[] {
    this.ensureInit();
    const rows = this.db.prepare(`
      SELECT * FROM events WHERE session_id = ? ORDER BY timestamp ASC
    `).all(sessionId) as any[];
    return rows.map(this.rowToEvent);
  }

  getRecentEvents(limit: number = 100): Event[] {
    this.ensureInit();
    const rows = this.db.prepare(`
      SELECT * FROM events ORDER BY timestamp DESC LIMIT ?
    `).all(limit) as any[];
    return rows.map(this.rowToEvent);
  }

  // ===========================================================================
  // Memory Unit Operations
  // ===========================================================================

  createMemory(
    store: MemoryStore,
    classification: MemoryClassification,
    summary: string,
    sourceEventIds: string[],
    features: Partial<{
      sessionId: string;
      projectScope: string; // Project path for project-level memories, undefined for user-level
      importance: number;
      utility: number;
      novelty: number;
      confidence: number;
      tags: string[];
    }> = {}
  ): MemoryUnit {
    this.ensureInit();
    
    const now = new Date();
    const decayRate = store === 'stm' ? this.config.stmDecayRate : this.config.ltmDecayRate;
    
    const memory: MemoryUnit = {
      id: uuidv4(),
      sessionId: features.sessionId,
      store,
      classification,
      summary,
      sourceEventIds,
      projectScope: features.projectScope,
      createdAt: now,
      updatedAt: now,
      lastAccessedAt: now,
      recency: 0,
      frequency: 1,
      importance: features.importance ?? 0.5,
      utility: features.utility ?? 0.5,
      novelty: features.novelty ?? 0.5,
      confidence: features.confidence ?? 0.5,
      interference: 0,
      strength: this.calculateStrength({
        recency: 0,
        frequency: 1,
        importance: features.importance ?? 0.5,
        utility: features.utility ?? 0.5,
        novelty: features.novelty ?? 0.5,
        confidence: features.confidence ?? 0.5,
        interference: 0,
      }),
      decayRate,
      tags: features.tags ?? [],
      associations: [],
      status: 'active',
      version: 1,
      evidence: [],
    };

    this.db.prepare(`
      INSERT INTO memory_units (
        id, session_id, store, classification, summary, source_event_ids, project_scope,
        created_at, updated_at, last_accessed_at,
        recency, frequency, importance, utility, novelty, confidence, interference,
        strength, decay_rate, tags, associations, status, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      memory.id,
      memory.sessionId ?? null,
      memory.store,
      memory.classification,
      memory.summary,
      JSON.stringify(memory.sourceEventIds),
      memory.projectScope ?? null,
      memory.createdAt.toISOString(),
      memory.updatedAt.toISOString(),
      memory.lastAccessedAt.toISOString(),
      memory.recency,
      memory.frequency,
      memory.importance,
      memory.utility,
      memory.novelty,
      memory.confidence,
      memory.interference,
      memory.strength,
      memory.decayRate,
      JSON.stringify(memory.tags),
      JSON.stringify(memory.associations),
      memory.status,
      memory.version
    );

    return memory;
  }

  getMemory(memoryId: string): MemoryUnit | null {
    this.ensureInit();
    const row = this.db.prepare(`SELECT * FROM memory_units WHERE id = ?`).get(memoryId) as any;
    if (!row) return null;
    return this.rowToMemoryUnit(row);
  }

  getMemoriesByStore(store: MemoryStore, status: MemoryStatus = 'active'): MemoryUnit[] {
    this.ensureInit();
    const rows = this.db.prepare(`
      SELECT * FROM memory_units 
      WHERE store = ? AND status = ?
      ORDER BY strength DESC
    `).all(store, status) as any[];
    return rows.map(this.rowToMemoryUnit.bind(this));
  }

  getTopMemories(limit: number = 20, store?: MemoryStore): MemoryUnit[] {
    this.ensureInit();
    
    let query = `SELECT * FROM memory_units WHERE status = 'active'`;
    const params: any[] = [];
    
    if (store) {
      query += ` AND store = ?`;
      params.push(store);
    }
    
    query += ` ORDER BY strength DESC LIMIT ?`;
    params.push(limit);
    
    const rows = this.db.prepare(query).all(...params) as any[];
    return rows.map(this.rowToMemoryUnit.bind(this));
  }

  /**
   * Get memories filtered by scope for context injection.
   * Returns:
   * - All user-level memories (classification in constraint, preference, learning, procedural)
   * - Project-level memories only if they match the given project
   * 
   * @param currentProject - The current project path (used to filter project-level memories)
   * @param limit - Maximum number of memories to return
   * @param store - Optional filter by STM/LTM
   */
  getMemoriesByScope(currentProject?: string, limit: number = 20, store?: MemoryStore): MemoryUnit[] {
    this.ensureInit();
    
    // User-level classifications (always included)
    const userLevelClassifications = ['constraint', 'preference', 'learning', 'procedural'];
    const userClassPlaceholders = userLevelClassifications.map(() => '?').join(', ');
    
    // Build query: user-level OR (project-level AND matching project)
    let query = `
      SELECT * FROM memory_units 
      WHERE status = 'active' 
      AND (
        classification IN (${userClassPlaceholders})
        OR (project_scope IS NOT NULL AND project_scope = ?)
      )
    `;
    const params: any[] = [...userLevelClassifications, currentProject ?? ''];
    
    if (store) {
      query += ` AND store = ?`;
      params.push(store);
    }
    
    query += ` ORDER BY strength DESC LIMIT ?`;
    params.push(limit);
    
    const rows = this.db.prepare(query).all(...params) as any[];
    return rows.map(this.rowToMemoryUnit.bind(this));
  }

  /**
   * Get only user-level memories (always applicable across all projects)
   */
  getUserLevelMemories(limit: number = 20, store?: MemoryStore): MemoryUnit[] {
    this.ensureInit();
    
    const userLevelClassifications = ['constraint', 'preference', 'learning', 'procedural'];
    const placeholders = userLevelClassifications.map(() => '?').join(', ');
    
    let query = `
      SELECT * FROM memory_units 
      WHERE status = 'active' 
      AND classification IN (${placeholders})
    `;
    const params: any[] = [...userLevelClassifications];
    
    if (store) {
      query += ` AND store = ?`;
      params.push(store);
    }
    
    query += ` ORDER BY strength DESC LIMIT ?`;
    params.push(limit);
    
    const rows = this.db.prepare(query).all(...params) as any[];
    return rows.map(this.rowToMemoryUnit.bind(this));
  }

  /**
   * Get project-level memories for a specific project
   */
  getProjectMemories(project: string, limit: number = 20, store?: MemoryStore): MemoryUnit[] {
    this.ensureInit();
    
    let query = `
      SELECT * FROM memory_units 
      WHERE status = 'active' 
      AND project_scope = ?
    `;
    const params: any[] = [project];
    
    if (store) {
      query += ` AND store = ?`;
      params.push(store);
    }
    
    query += ` ORDER BY strength DESC LIMIT ?`;
    params.push(limit);
    
    const rows = this.db.prepare(query).all(...params) as any[];
    return rows.map(this.rowToMemoryUnit.bind(this));
  }

  updateMemoryStrength(memoryId: string, strength: number): void {
    this.ensureInit();
    this.db.prepare(`
      UPDATE memory_units 
      SET strength = ?, updated_at = ?
      WHERE id = ?
    `).run(strength, new Date().toISOString(), memoryId);
  }

  updateMemoryStatus(memoryId: string, status: MemoryStatus): void {
    this.ensureInit();
    this.db.prepare(`
      UPDATE memory_units 
      SET status = ?, updated_at = ?
      WHERE id = ?
    `).run(status, new Date().toISOString(), memoryId);
  }

  incrementFrequency(memoryId: string): void {
    this.ensureInit();
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE memory_units 
      SET frequency = frequency + 1, last_accessed_at = ?, updated_at = ?
      WHERE id = ?
    `).run(now, now, memoryId);
  }

  promoteToLtm(memoryId: string): void {
    this.ensureInit();
    this.db.prepare(`
      UPDATE memory_units 
      SET store = 'ltm', decay_rate = ?, updated_at = ?
      WHERE id = ?
    `).run(this.config.ltmDecayRate, new Date().toISOString(), memoryId);
  }

  // ===========================================================================
  // Embedding Operations (only available in Node.js with sqlite-vec)
  // ===========================================================================

  storeEmbedding(memoryId: string, embedding: number[]): void {
    if (!this.vecEnabled) return;
    this.ensureInit();
    
    this.db.prepare(`
      INSERT OR REPLACE INTO memory_embeddings (memory_id, embedding)
      VALUES (?, ?)
    `).run(memoryId, JSON.stringify(embedding));
  }

  searchByEmbedding(queryEmbedding: number[], limit: number = 10): Array<{ memoryId: string; distance: number }> {
    if (!this.vecEnabled) return [];
    this.ensureInit();
    
    const rows = this.db.prepare(`
      SELECT memory_id, distance
      FROM memory_embeddings
      WHERE embedding MATCH ?
      ORDER BY distance
      LIMIT ?
    `).all(JSON.stringify(queryEmbedding), limit) as any[];
    
    return rows.map(row => ({
      memoryId: row.memory_id,
      distance: row.distance,
    }));
  }

  // ===========================================================================
  // Retrieval Log Operations
  // ===========================================================================

  logRetrieval(
    sessionId: string,
    memoryId: string,
    query: string,
    relevanceScore: number
  ): string {
    this.ensureInit();
    const id = uuidv4();
    this.db.prepare(`
      INSERT INTO retrieval_logs (id, session_id, memory_id, query, timestamp, relevance_score)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, sessionId, memoryId, query, new Date().toISOString(), relevanceScore);
    return id;
  }

  markRetrievalUsed(logId: string, wasUsed: boolean): void {
    this.ensureInit();
    this.db.prepare(`
      UPDATE retrieval_logs SET was_used = ? WHERE id = ?
    `).run(wasUsed ? 1 : 0, logId);
  }

  addRetrievalFeedback(logId: string, feedback: 'positive' | 'negative' | 'neutral'): void {
    this.ensureInit();
    this.db.prepare(`
      UPDATE retrieval_logs SET user_feedback = ? WHERE id = ?
    `).run(feedback, logId);
  }

  // ===========================================================================
  // Feedback Operations
  // ===========================================================================

  addFeedback(
    type: 'remember' | 'forget' | 'pin' | 'correct',
    memoryId?: string,
    content?: string
  ): void {
    this.ensureInit();
    this.db.prepare(`
      INSERT INTO feedback (id, memory_id, type, content, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `).run(uuidv4(), memoryId ?? null, type, content ?? null, new Date().toISOString());

    // Apply feedback immediately
    if (memoryId) {
      switch (type) {
        case 'pin':
          this.updateMemoryStatus(memoryId, 'pinned');
          break;
        case 'forget':
          this.updateMemoryStatus(memoryId, 'forgotten');
          break;
        case 'remember':
          // Boost importance and promote to LTM
          this.db.prepare(`
            UPDATE memory_units 
            SET importance = MIN(1.0, importance + 0.3), store = 'ltm', decay_rate = ?
            WHERE id = ?
          `).run(this.config.ltmDecayRate, memoryId);
          break;
      }
    }
  }

  // ===========================================================================
  // Decay and Consolidation
  // ===========================================================================

  /**
   * Apply exponential decay to all active memories
   * strength_t = strength_0 * exp(-lambda * dt)
   */
  applyDecay(): number {
    this.ensureInit();
    const now = new Date();
    const memories = this.db.prepare(`
      SELECT id, strength, decay_rate, updated_at, status
      FROM memory_units
      WHERE status = 'active'
    `).all() as any[];

    let decayedCount = 0;
    const decayThreshold = 0.1; // Below this, mark as decayed

    for (const mem of memories) {
      const updatedAt = new Date(mem.updated_at);
      const dtHours = (now.getTime() - updatedAt.getTime()) / (1000 * 60 * 60);
      const newStrength = mem.strength * Math.exp(-mem.decay_rate * dtHours);

      if (newStrength < decayThreshold) {
        this.updateMemoryStatus(mem.id, 'decayed');
        decayedCount++;
      } else if (newStrength !== mem.strength) {
        this.updateMemoryStrength(mem.id, newStrength);
      }
    }

    return decayedCount;
  }

  /**
   * Check and promote eligible STM memories to LTM
   */
  runConsolidation(): number {
    this.ensureInit();
    const stmMemories = this.getMemoriesByStore('stm');
    let promotedCount = 0;

    for (const mem of stmMemories) {
      const shouldPromote =
        mem.strength >= this.config.stmToLtmStrengthThreshold ||
        mem.frequency >= this.config.stmToLtmFrequencyThreshold ||
        this.config.autoPromoteToLtm.includes(mem.classification);

      if (shouldPromote) {
        this.promoteToLtm(mem.id);
        promotedCount++;
      }
    }

    return promotedCount;
  }

  // ===========================================================================
  // Scoring
  // ===========================================================================

  /**
   * Calculate memory strength from feature vector (rule-based v1)
   */
  calculateStrength(features: {
    recency: number;
    frequency: number;
    importance: number;
    utility: number;
    novelty: number;
    confidence: number;
    interference: number;
  }): number {
    const w = this.config.scoringWeights;
    
    // Normalize frequency (log scale)
    const normalizedFrequency = Math.min(1, Math.log(features.frequency + 1) / Math.log(10));
    
    // Recency factor (0 = now, 1 = old)
    const recencyFactor = 1 - Math.min(1, features.recency / 168); // 168 hours = 1 week
    
    const strength =
      w.recency * recencyFactor +
      w.frequency * normalizedFrequency +
      w.importance * features.importance +
      w.utility * features.utility +
      w.novelty * features.novelty +
      w.confidence * features.confidence +
      w.interference * features.interference; // Negative weight

    return Math.max(0, Math.min(1, strength));
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  private rowToSession(row: any): Session {
    return {
      id: row.id,
      project: row.project,
      startedAt: new Date(row.started_at),
      endedAt: row.ended_at ? new Date(row.ended_at) : undefined,
      status: row.status,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      transcriptPath: row.transcript_path ?? undefined,
      transcriptWatermark: row.transcript_watermark ?? 0,
      messageWatermark: row.message_watermark ?? 0,
    };
  }

  private rowToEvent(row: any): Event {
    return {
      id: row.id,
      sessionId: row.session_id,
      hookType: row.hook_type as HookType,
      timestamp: new Date(row.timestamp),
      content: row.content,
      toolName: row.tool_name ?? undefined,
      toolInput: row.tool_input ?? undefined,
      toolOutput: row.tool_output ?? undefined,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
    };
  }

  private rowToMemoryUnit(row: any): MemoryUnit {
    return {
      id: row.id,
      sessionId: row.session_id ?? undefined,
      store: row.store as MemoryStore,
      classification: row.classification as MemoryClassification,
      summary: row.summary,
      sourceEventIds: JSON.parse(row.source_event_ids),
      projectScope: row.project_scope ?? undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      lastAccessedAt: new Date(row.last_accessed_at),
      recency: row.recency,
      frequency: row.frequency,
      importance: row.importance,
      utility: row.utility,
      novelty: row.novelty,
      confidence: row.confidence,
      interference: row.interference,
      strength: row.strength,
      decayRate: row.decay_rate,
      tags: row.tags ? JSON.parse(row.tags) : [],
      associations: row.associations ? JSON.parse(row.associations) : [],
      status: row.status as MemoryStatus,
      version: row.version,
      evidence: [], // Loaded separately if needed
    };
  }

  /**
   * Check if vector search is enabled
   */
  isVecEnabled(): boolean {
    return this.vecEnabled;
  }

  /**
   * Close database connection
   */
  close(): void {
    if (this.db) {
      this.db.close();
    }
  }
}

/**
 * Create and initialize a MemoryDatabase instance
 */
export async function createMemoryDatabase(config: Partial<PsychMemConfig> = {}): Promise<MemoryDatabase> {
  const db = new MemoryDatabase(config);
  await db.init();
  return db;
}
