/**
 * adapter.test.ts
 *
 * Tests for the OpenCode adapter's exported pure functions:
 *
 * preFilterImportance(text, threshold):
 *   - Gate 1: pure task commands (imperative verb, no memory signal) → false
 *   - Gate 2: positive-signal scoring against threshold
 *   - Default threshold 0.3 (≥ 2/7 pattern groups must match)
 *   - Explicit memory signals always pass
 *   - Low-signal conversation does not pass
 *
 * parsePluginConfig():
 *   - Returns correct defaults when no env vars are set
 *   - Respects PSYCHMEM_MESSAGE_IMPORTANCE_THRESHOLD override
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { preFilterImportance, parsePluginConfig } from './index.js';

// ---------------------------------------------------------------------------
// preFilterImportance — Gate 1: task command disqualification
// ---------------------------------------------------------------------------

describe('preFilterImportance — Gate 1: task command disqualification', () => {
  const threshold = 0.3; // default

  it('returns false for a bare "run tests" command', () => {
    assert.equal(preFilterImportance('run the tests', threshold), false);
  });

  it('returns false for a bare "build the project" command', () => {
    assert.equal(preFilterImportance('build the project', threshold), false);
  });

  it('returns false for "fetch the latest data" with no memory signal', () => {
    assert.equal(preFilterImportance('fetch the latest data from the API', threshold), false);
  });

  it('returns false for "create a new file" with no memory signal', () => {
    assert.equal(preFilterImportance('create a new component file', threshold), false);
  });

  it('returns false for "install dependencies" with no memory signal', () => {
    assert.equal(preFilterImportance('install dependencies', threshold), false);
  });

  it('returns false for "delete the old logs" with no memory signal', () => {
    assert.equal(preFilterImportance('delete the old logs', threshold), false);
  });

  // Gate 1 override: task command that DOES have a memory signal passes Gate 1
  // (then Gate 2 decides)
  it('passes Gate 1 when task command contains "never" (memory signal)', () => {
    // "never" matches both the memory signal override and Gate 2 patterns.
    // We only assert it is NOT disqualified by Gate 1 — it may pass or fail overall.
    // In practice, "never" hits Gate 2 ≥ 1 pattern → passes.
    const result = preFilterImportance('run tests but never use --force', threshold);
    // should pass (memory signal present)
    assert.equal(result, true);
  });

  it('passes Gate 1 when task command contains "important" keyword', () => {
    const result = preFilterImportance('build the project — important: do not minify', threshold);
    assert.equal(result, true);
  });
});

// ---------------------------------------------------------------------------
// preFilterImportance — Gate 2: positive signal scoring
// ---------------------------------------------------------------------------

describe('preFilterImportance — Gate 2: positive signal scoring', () => {
  const threshold = 0.3; // ≥ 2.1/7 → at least 3 matches ... wait:
  // 0.3 * 7 = 2.1, so matchCount >= 2.1 is never an integer — effectively ≥ 3?
  // No: score = matchCount / 7; score >= 0.3 → matchCount >= 0.3*7=2.1 → matchCount >= 3.
  // But the comment in code says "threshold 0.5 → at least 2 matches" for 4 groups.
  // Here threshold=0.3, 7 groups: 0.3*7 = 2.1 → need matchCount >= 3.
  // Use 0.14 threshold: 1/7 ≈ 0.1428 >= 0.14, so exactly 1 match is sufficient.
  const looseThreshold = 0.14;

  it('returns true for explicit memory request ("remember")', () => {
    assert.equal(preFilterImportance('remember to always run linting before committing', looseThreshold), true);
  });

  it('returns true for constraint language ("never use eval")', () => {
    assert.equal(preFilterImportance('never use eval in this project', looseThreshold), true);
  });

  it('returns true for "don\'t" constraint', () => {
    assert.equal(preFilterImportance("don't add console.log statements", looseThreshold), true);
  });

  it('returns true for learning indicator ("I realized")', () => {
    assert.equal(preFilterImportance('I realized the import order matters here', looseThreshold), true);
  });

  it('returns true for decision indicator ("I decided")', () => {
    assert.equal(preFilterImportance('I decided to use Bun instead of Node', looseThreshold), true);
  });

  it('returns true for correction indicator ("no, that is wrong")', () => {
    assert.equal(preFilterImportance('no, that approach is wrong', looseThreshold), true);
  });

  it('returns true for bug indicator ("bug in the parser")', () => {
    assert.equal(preFilterImportance('there is a bug in the parser', looseThreshold), true);
  });

  it('returns true for "!!" emphasis', () => {
    assert.equal(preFilterImportance('Do NOT push directly to main!!', looseThreshold), true);
  });

  it('returns false for generic short message at default threshold', () => {
    // "okay" or "sounds good" — no signals at all
    assert.equal(preFilterImportance('sounds good', threshold), false);
  });

  it('returns false for a plain question at default threshold', () => {
    assert.equal(preFilterImportance('what does this function do', threshold), false);
  });

  it('returns false for a status update with no signals at default threshold', () => {
    assert.equal(preFilterImportance('the tests are passing now', threshold), false);
  });
});

// ---------------------------------------------------------------------------
// preFilterImportance — threshold sensitivity
// ---------------------------------------------------------------------------

describe('preFilterImportance — threshold behaviour', () => {
  it('threshold=0 always returns true (any text)', () => {
    assert.equal(preFilterImportance('hello', 0), true);
  });

  it('threshold=1 never returns true unless all 7 patterns match', () => {
    // Very unlikely to hit all 7 in one sentence — confirm a normal message fails.
    assert.equal(preFilterImportance('run the build', 1), false);
  });

  it('a rich message with 4+ signals passes threshold=0.5 (4/7 ≈ 0.57)', () => {
    // Hits: "remember" (explicit), "never" (constraint), "bug" (bug), "decided" (decision)
    // matchCount = 4, score = 4/7 ≈ 0.57 ≥ 0.5
    const text = 'remember we decided to never use callbacks due to a bug last sprint';
    assert.equal(preFilterImportance(text, 0.5), true);
  });

  it('same rich message fails at threshold=0.9', () => {
    const text = 'remember we decided to never use callbacks due to a bug last sprint';
    assert.equal(preFilterImportance(text, 0.9), false);
  });
});

// ---------------------------------------------------------------------------
// parsePluginConfig — defaults and env var overrides
// ---------------------------------------------------------------------------

describe('parsePluginConfig — default values', () => {
  // Clear any env vars that might be set from a parent process
  before(() => {
    delete process.env['PSYCHMEM_INJECT_ON_COMPACTION'];
    delete process.env['PSYCHMEM_EXTRACT_ON_COMPACTION'];
    delete process.env['PSYCHMEM_EXTRACT_ON_USER_MESSAGE'];
    delete process.env['PSYCHMEM_EXTRACT_ON_MESSAGE'];
    delete process.env['PSYCHMEM_MAX_COMPACTION_MEMORIES'];
    delete process.env['PSYCHMEM_MAX_SESSION_MEMORIES'];
    delete process.env['PSYCHMEM_MESSAGE_WINDOW_SIZE'];
    delete process.env['PSYCHMEM_MESSAGE_IMPORTANCE_THRESHOLD'];
  });

  after(() => {
    delete process.env['PSYCHMEM_MESSAGE_IMPORTANCE_THRESHOLD'];
  });

  it('messageImportanceThreshold defaults to 0.3', () => {
    const cfg = parsePluginConfig();
    assert.equal(cfg.opencode?.messageImportanceThreshold, 0.3);
  });

  it('injectOnCompaction defaults to true', () => {
    const cfg = parsePluginConfig();
    assert.equal(cfg.opencode?.injectOnCompaction, true);
  });

  it('extractOnCompaction defaults to true', () => {
    const cfg = parsePluginConfig();
    assert.equal(cfg.opencode?.extractOnCompaction, true);
  });

  it('extractOnUserMessage defaults to true', () => {
    const cfg = parsePluginConfig();
    assert.equal(cfg.opencode?.extractOnUserMessage, true);
  });

  it('maxCompactionMemories defaults to 10', () => {
    const cfg = parsePluginConfig();
    assert.equal(cfg.opencode?.maxCompactionMemories, 10);
  });

  it('maxSessionStartMemories defaults to 10', () => {
    const cfg = parsePluginConfig();
    assert.equal(cfg.opencode?.maxSessionStartMemories, 10);
  });

  it('messageWindowSize defaults to 3', () => {
    const cfg = parsePluginConfig();
    assert.equal(cfg.opencode?.messageWindowSize, 3);
  });
});

describe('parsePluginConfig — env var overrides', () => {
  after(() => {
    delete process.env['PSYCHMEM_MESSAGE_IMPORTANCE_THRESHOLD'];
    delete process.env['PSYCHMEM_INJECT_ON_COMPACTION'];
    delete process.env['PSYCHMEM_MAX_SESSION_MEMORIES'];
  });

  it('PSYCHMEM_MESSAGE_IMPORTANCE_THRESHOLD overrides default', () => {
    process.env['PSYCHMEM_MESSAGE_IMPORTANCE_THRESHOLD'] = '0.75';
    const cfg = parsePluginConfig();
    assert.equal(cfg.opencode?.messageImportanceThreshold, 0.75);
  });

  it('PSYCHMEM_INJECT_ON_COMPACTION=false overrides default', () => {
    process.env['PSYCHMEM_INJECT_ON_COMPACTION'] = 'false';
    const cfg = parsePluginConfig();
    assert.equal(cfg.opencode?.injectOnCompaction, false);
  });

  it('PSYCHMEM_MAX_SESSION_MEMORIES=5 overrides default', () => {
    process.env['PSYCHMEM_MAX_SESSION_MEMORIES'] = '5';
    const cfg = parsePluginConfig();
    assert.equal(cfg.opencode?.maxSessionStartMemories, 5);
  });
});
