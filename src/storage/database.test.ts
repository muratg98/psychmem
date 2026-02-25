/**
 * database.test.ts
 *
 * Targeted tests for schema changes in database.ts:
 *
 * 1. Fresh DB creates schema version 4 (not 3)
 * 2. Fresh DB does NOT have transcript_path or transcript_watermark columns
 * 3. Fresh DB DOES have embedding BLOB column on memory_units
 * 4. createSession INSERT works (no reference to dead columns)
 * 5. Migration: a v2 DB with transcript_path and transcript_watermark gets
 *    those columns dropped when re-opened with the v4 code
 * 6. Migration: a v3 DB without embedding column gets it added when re-opened
 * 7. After migration, schema_version table records version 4
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'os';
import { join } from 'path';
import { unlinkSync, existsSync } from 'fs';

import { createMemoryDatabase, MemoryDatabase } from './database.js';
import { createDatabase } from './sqlite-adapter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _dbIndex = 0;

/** Returns a unique temp file path for a test DB. Cleaned up in after(). */
const tempFiles: string[] = [];
function tempDbPath(): string {
  const p = join(tmpdir(), `psychmem-test-${process.pid}-${++_dbIndex}.db`);
  tempFiles.push(p);
  return p;
}

after(() => {
  for (const f of tempFiles) {
    try { if (existsSync(f)) unlinkSync(f); } catch (_) { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// Fresh DB — schema version 4
// ---------------------------------------------------------------------------

describe('fresh database — schema version 4', () => {
  it('schema_version table contains version 4', async () => {
    const path = tempDbPath();
    const db = await createMemoryDatabase({ dbPath: path });
    try {
      const rawDb = await createDatabase(path);
      const row = rawDb.prepare('SELECT version FROM schema_version ORDER BY rowid DESC LIMIT 1').get() as { version: number } | undefined;
      rawDb.close();
      assert.ok(row, 'expected a schema_version row');
      assert.equal(row.version, 4, `expected schema version 4, got ${row.version}`);
    } finally {
      db.close();
    }
  });

  it('does NOT have transcript_path column on sessions table', async () => {
    const path = tempDbPath();
    const db = await createMemoryDatabase({ dbPath: path });
    try {
      const rawDb = await createDatabase(path);
      const cols = rawDb.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
      rawDb.close();
      const colNames = cols.map(c => c.name);
      assert.ok(!colNames.includes('transcript_path'), 'transcript_path should not exist on fresh DB');
      assert.ok(!colNames.includes('transcript_watermark'), 'transcript_watermark should not exist on fresh DB');
    } finally {
      db.close();
    }
  });

  it('sessions table has message_watermark column', async () => {
    const path = tempDbPath();
    const db = await createMemoryDatabase({ dbPath: path });
    try {
      const rawDb = await createDatabase(path);
      const cols = rawDb.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
      rawDb.close();
      const colNames = cols.map(c => c.name);
      assert.ok(colNames.includes('message_watermark'), 'message_watermark should exist');
    } finally {
      db.close();
    }
  });

  it('memory_units table has embedding BLOB column', async () => {
    const path = tempDbPath();
    const db = await createMemoryDatabase({ dbPath: path });
    try {
      const rawDb = await createDatabase(path);
      const cols = rawDb.prepare('PRAGMA table_info(memory_units)').all() as Array<{ name: string; type: string }>;
      rawDb.close();
      const embeddingCol = cols.find(c => c.name === 'embedding');
      assert.ok(embeddingCol, 'embedding column should exist on memory_units');
      assert.equal(embeddingCol.type.toUpperCase(), 'BLOB', `expected BLOB type, got ${embeddingCol.type}`);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// createSession — INSERT works without transcript columns
// ---------------------------------------------------------------------------

describe('createSession — INSERT works correctly', () => {
  it('creates a session and returns it without error', async () => {
    const db = await createMemoryDatabase({ dbPath: tempDbPath() });
    try {
      const session = db.createSession('/projects/test', { env: 'test' });
      assert.ok(session.id, 'session should have an id');
      assert.equal(session.project, '/projects/test');
      assert.equal(session.status, 'active');
      assert.equal(session.messageWatermark, 0);
    } finally {
      db.close();
    }
  });

  it('getSession retrieves the created session', async () => {
    const db = await createMemoryDatabase({ dbPath: tempDbPath() });
    try {
      const created = db.createSession('/projects/test');
      const retrieved = db.getSession(created.id);
      assert.ok(retrieved, 'getSession should return the created session');
      assert.equal(retrieved.id, created.id);
      assert.equal(retrieved.project, '/projects/test');
    } finally {
      db.close();
    }
  });

  it('message watermark is 0 after session creation', async () => {
    const db = await createMemoryDatabase({ dbPath: tempDbPath() });
    try {
      const session = db.createSession('/projects/test');
      const watermark = db.getMessageWatermark(session.id);
      assert.equal(watermark, 0);
    } finally {
      db.close();
    }
  });

  it('updateMessageWatermark stores and retrieves correctly', async () => {
    const db = await createMemoryDatabase({ dbPath: tempDbPath() });
    try {
      const session = db.createSession('/projects/test');
      db.updateMessageWatermark(session.id, 42);
      const watermark = db.getMessageWatermark(session.id);
      assert.equal(watermark, 42);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// setMemoryEmbedding — persists and round-trips Float32Array
// ---------------------------------------------------------------------------

describe('setMemoryEmbedding — round-trip BLOB storage', () => {
  it('stores a Float32Array and reads it back as Float32Array', async () => {
    const db = await createMemoryDatabase({ dbPath: tempDbPath() });
    try {
      const session = db.createSession('/projects/test');
      const memory = db.createMemory('stm', 'preference', 'Test memory for embedding', [], {
        sessionId: session.id,
      });

      // Construct a small known embedding
      const vec = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5]);
      db.setMemoryEmbedding(memory.id, vec);

      // Read back via getMemory
      const retrieved = db.getMemory(memory.id);
      assert.ok(retrieved, 'getMemory should return the memory');
      assert.ok(retrieved.embedding instanceof Float32Array, 'embedding should be a Float32Array');
      assert.equal(retrieved.embedding.length, vec.length, 'embedding length should match');
      for (let i = 0; i < vec.length; i++) {
        assert.ok(
          Math.abs(retrieved.embedding[i]! - vec[i]!) < 1e-6,
          `embedding[${i}] mismatch: expected ${vec[i]}, got ${retrieved.embedding[i]}`
        );
      }
    } finally {
      db.close();
    }
  });

  it('embedding is undefined for memories with no embedding set', async () => {
    const db = await createMemoryDatabase({ dbPath: tempDbPath() });
    try {
      const memory = db.createMemory('ltm', 'learning', 'Memory without embedding', []);
      const retrieved = db.getMemory(memory.id);
      assert.ok(retrieved, 'getMemory should return the memory');
      assert.equal(retrieved.embedding, undefined, 'embedding should be undefined when not set');
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Migration: v2 DB → v4
// ---------------------------------------------------------------------------

describe('migration from v2 to v4', () => {
  it('drops transcript columns and adds embedding column from a v2 DB', async () => {
    const path = tempDbPath();

    // Step 1: Create a raw v2-style DB with the old schema
    const rawDb = await createDatabase(path);
    rawDb.exec(`PRAGMA journal_mode = WAL`);
    rawDb.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER NOT NULL,
        applied_at TEXT NOT NULL
      );

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

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        hook_type TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_name TEXT,
        tool_input TEXT,
        tool_output TEXT,
        metadata TEXT
      );

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
        version INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS memory_evidence (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        contribution TEXT,
        confidence_delta REAL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS retrieval_logs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        memory_id TEXT NOT NULL,
        query TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        was_used INTEGER NOT NULL DEFAULT 0,
        user_feedback TEXT,
        relevance_score REAL NOT NULL
      );

      CREATE TABLE IF NOT EXISTS feedback (
        id TEXT PRIMARY KEY,
        memory_id TEXT,
        type TEXT NOT NULL,
        content TEXT,
        timestamp TEXT NOT NULL
      );
    `);

    // Stamp as version 2
    rawDb.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(2, new Date().toISOString());

    // Insert a test session row with the old columns
    rawDb.prepare(`
      INSERT INTO sessions (id, project, started_at, status, transcript_path, transcript_watermark, message_watermark)
      VALUES ('test-id', '/projects/test', ?, 'active', '/tmp/transcript.txt', 5, 10)
    `).run(new Date().toISOString());

    rawDb.close();

    // Step 2: Re-open with MemoryDatabase — should run v2→v4 migration
    const db = await createMemoryDatabase({ dbPath: path });
    db.close();

    // Step 3: Inspect the result
    const inspectDb = await createDatabase(path);

    // Schema version should now be 4
    const versionRow = inspectDb.prepare('SELECT version FROM schema_version ORDER BY rowid DESC LIMIT 1').get() as { version: number };
    assert.equal(versionRow.version, 4, `expected schema version 4 after migration, got ${versionRow.version}`);

    // transcript_path and transcript_watermark should be gone
    const sessionCols = inspectDb.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
    const sessionColNames = sessionCols.map(c => c.name);
    assert.ok(!sessionColNames.includes('transcript_path'), 'transcript_path should be dropped after migration');
    assert.ok(!sessionColNames.includes('transcript_watermark'), 'transcript_watermark should be dropped after migration');

    // message_watermark should still be there
    assert.ok(sessionColNames.includes('message_watermark'), 'message_watermark should still exist after migration');

    // The existing row's message_watermark data should survive
    const session = inspectDb.prepare('SELECT * FROM sessions WHERE id = ?').get('test-id') as Record<string, unknown>;
    assert.equal(session['message_watermark'], 10, 'existing row data should survive migration');

    // embedding column should now exist on memory_units
    const memoryCols = inspectDb.prepare('PRAGMA table_info(memory_units)').all() as Array<{ name: string }>;
    const memoryColNames = memoryCols.map(c => c.name);
    assert.ok(memoryColNames.includes('embedding'), 'embedding column should be added after migration');

    inspectDb.close();
  });
});

// ---------------------------------------------------------------------------
// Migration: v3 DB → v4
// ---------------------------------------------------------------------------

describe('migration from v3 to v4', () => {
  it('adds embedding column to memory_units from a v3 DB (no embedding column)', async () => {
    const path = tempDbPath();

    // Step 1: Create a v3-style DB (no embedding column)
    const rawDb = await createDatabase(path);
    rawDb.exec(`PRAGMA journal_mode = WAL`);
    rawDb.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER NOT NULL,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        metadata TEXT,
        message_watermark INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        hook_type TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_name TEXT,
        tool_input TEXT,
        tool_output TEXT,
        metadata TEXT
      );

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
        version INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS memory_evidence (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        contribution TEXT,
        confidence_delta REAL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS retrieval_logs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        memory_id TEXT NOT NULL,
        query TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        was_used INTEGER NOT NULL DEFAULT 0,
        user_feedback TEXT,
        relevance_score REAL NOT NULL
      );

      CREATE TABLE IF NOT EXISTS feedback (
        id TEXT PRIMARY KEY,
        memory_id TEXT,
        type TEXT NOT NULL,
        content TEXT,
        timestamp TEXT NOT NULL
      );
    `);

    // Stamp as version 3
    rawDb.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(3, new Date().toISOString());
    rawDb.close();

    // Step 2: Re-open with MemoryDatabase — should run v3→v4 migration
    const db = await createMemoryDatabase({ dbPath: path });
    db.close();

    // Step 3: Inspect
    const inspectDb = await createDatabase(path);

    const versionRow = inspectDb.prepare('SELECT version FROM schema_version ORDER BY rowid DESC LIMIT 1').get() as { version: number };
    assert.equal(versionRow.version, 4, `expected schema version 4 after v3→v4 migration, got ${versionRow.version}`);

    const memoryCols = inspectDb.prepare('PRAGMA table_info(memory_units)').all() as Array<{ name: string }>;
    const memoryColNames = memoryCols.map(c => c.name);
    assert.ok(memoryColNames.includes('embedding'), 'embedding column should be added after v3→v4 migration');

    inspectDb.close();
  });
});

// ---------------------------------------------------------------------------
// Already-v4 DB does not re-run migration
// ---------------------------------------------------------------------------

describe('idempotency — re-opening a v4 DB does not fail', () => {
  it('opening an already-v4 DB twice does not throw', async () => {
    const path = tempDbPath();
    const db1 = await createMemoryDatabase({ dbPath: path });
    db1.createSession('/projects/foo');
    db1.close();

    // Re-open — should not throw
    const db2 = await createMemoryDatabase({ dbPath: path });
    const session = db2.createSession('/projects/bar');
    assert.ok(session.id);
    db2.close();
  });
});
