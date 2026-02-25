/**
 * context-sweep.test.ts
 *
 * Targeted tests for changes made to context-sweep.ts and its configuration:
 *
 * 1. isContentQualityAcceptable (private, tested indirectly via extractCandidates)
 *    - Rejects content ending with ...[truncated] or ...
 *    - Rejects content where >50% of lines have line-number prefixes (Read tool output)
 *    - Rejects content where >60% of chars are inside code fences/inline code
 *    - Rejects content where special-char density > 30%
 *    - Rejects content where > 70% of lines are bare file paths
 *
 * 2. signalThreshold raised from 0.3 → 0.5
 *    - A text that only produces sub-0.5 structural signals (code block at 0.25,
 *      url at 0.2) must NOT produce a memory candidate.
 *    - A text with an explicit remember phrase (weight 0.9) MUST produce a candidate.
 *
 * We drive extraction via Stop events carrying conversationText so the full pipeline
 * runs (extractFromConversationText path).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ContextSweep } from './context-sweep.js';
import type { Event } from '../types/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _eventId = 0;
function makeStopEvent(conversationText: string): Event {
  return {
    id: `evt-${++_eventId}`,
    sessionId: 'test-session',
    hookType: 'Stop',
    timestamp: new Date(),
    content: conversationText,
  };
}

function makeUserPromptEvent(content: string): Event {
  return {
    id: `evt-${++_eventId}`,
    sessionId: 'test-session',
    hookType: 'UserPromptSubmit',
    timestamp: new Date(),
    content,
  };
}

// ---------------------------------------------------------------------------
// signalThreshold = 0.5
// ---------------------------------------------------------------------------

describe('signalThreshold = 0.5 — low-weight-only text produces no candidates', () => {
  const sweep = new ContextSweep();

  it('code-only text (weight 0.25) produces no candidates', () => {
    // A chunk that only matches code_block (weight 0.25) — below threshold 0.5
    const text = 'Human: Here is the code\n```\nconst x = 1;\n```';
    const candidates = sweep.extractCandidates([makeStopEvent(text)]);
    assert.equal(candidates.length, 0, 'code-only text should not produce candidates');
  });

  it('file-path-only text (weight 0.25) produces no candidates', () => {
    const text = 'Human: Check /src/memory/patterns.ts for the implementation';
    const candidates = sweep.extractCandidates([makeStopEvent(text)]);
    assert.equal(candidates.length, 0, 'file-path text should not produce candidates');
  });

  it('URL-only text (weight 0.2) produces no candidates', () => {
    const text = 'Human: See https://example.com/docs';
    const candidates = sweep.extractCandidates([makeStopEvent(text)]);
    assert.equal(candidates.length, 0, 'URL-only text should not produce candidates');
  });

  it('colon-definition only (weight 0.3) produces no candidates', () => {
    const text = 'Human: Config: the main configuration object for the app';
    const candidates = sweep.extractCandidates([makeStopEvent(text)]);
    assert.equal(candidates.length, 0, 'definition-only text should not produce candidates');
  });
});

describe('signalThreshold = 0.5 — high-weight text DOES produce candidates', () => {
  const sweep = new ContextSweep();

  it('explicit "remember this" (weight 0.9) produces a candidate', () => {
    const text = 'Human: Remember this: always use strict mode in TypeScript';
    const candidates = sweep.extractCandidates([makeStopEvent(text)]);
    assert.ok(candidates.length > 0, 'explicit remember should produce a candidate');
  });

  it('"never do X" emphasis (weight 0.8) produces a candidate', () => {
    const text = 'Human: Never use eval() in this codebase — it is a security risk';
    const candidates = sweep.extractCandidates([makeStopEvent(text)]);
    assert.ok(candidates.length > 0, 'emphasis cue should produce a candidate');
  });

  it('"I prefer X" preference (weight 0.6) produces a candidate', () => {
    const text = 'Human: I prefer tabs over spaces for indentation in this project';
    const candidates = sweep.extractCandidates([makeStopEvent(text)]);
    assert.ok(candidates.length > 0, 'preference signal should produce a candidate');
  });
});

// ---------------------------------------------------------------------------
// isContentQualityAcceptable — tested indirectly
// ---------------------------------------------------------------------------

describe('quality gate — truncated content is rejected', () => {
  const sweep = new ContextSweep();

  it('content ending in ...[truncated] is rejected even with strong signal', () => {
    // "remember this" has weight 0.9 (above threshold), but content is truncated
    const text = 'Human: Remember this important information about the API...[truncated]';
    const candidates = sweep.extractCandidates([makeStopEvent(text)]);
    assert.equal(candidates.length, 0, 'truncated content should be rejected');
  });

  it('content ending in "..." (ellipsis) is rejected', () => {
    const text = 'Human: Always use strict mode and never skip the lint step...';
    const candidates = sweep.extractCandidates([makeStopEvent(text)]);
    assert.equal(candidates.length, 0, 'ellipsis-trailing content should be rejected');
  });
});

describe('quality gate — line-numbered Read tool output is rejected', () => {
  const sweep = new ContextSweep();

  it('majority of lines are line-number prefixed → rejected', () => {
    // This looks like output from the Read tool with line number prefixes.
    // "remember this" would normally trigger, but the quality gate should reject.
    const readOutput = [
      '1: import { foo } from "./foo.js";',
      '2: ',
      '3: // remember this: the main entry',
      '4: export function main() {',
      '5:   return foo();',
      '6: }',
    ].join('\n');
    const text = `Human: ${readOutput}`;
    const candidates = sweep.extractCandidates([makeStopEvent(text)]);
    assert.equal(candidates.length, 0, 'Read tool output should be rejected');
  });
});

describe('quality gate — code-heavy content is rejected', () => {
  const sweep = new ContextSweep();

  it('>60% code fence content with strong signal is rejected', () => {
    // The code fence wraps almost all of the content.
    // We add a strong signal (never) inside the fence block to confirm the gate
    // fires before saving this as memory.
    const text = [
      'Human: Here:',
      '```typescript',
      '// Never use var — always use const or let',
      'const x = 1;',
      'const y = 2;',
      'const z = x + y;',
      'function add(a: number, b: number): number {',
      '  return a + b;',
      '}',
      '```',
    ].join('\n');
    const candidates = sweep.extractCandidates([makeStopEvent(text)]);
    assert.equal(candidates.length, 0, 'code-heavy content should be rejected');
  });
});

describe('quality gate — file path list is rejected', () => {
  const sweep = new ContextSweep();

  it('>70% of lines are file paths → rejected', () => {
    const text = [
      'Human: Never mind, here are the relevant files:',
      '/src/memory/patterns.ts',
      '/src/memory/context-sweep.ts',
      '/src/memory/structural-analyzer.ts',
      '/src/storage/database.ts',
    ].join('\n');
    const candidates = sweep.extractCandidates([makeStopEvent(text)]);
    assert.equal(candidates.length, 0, 'file path list should be rejected');
  });
});

describe('quality gate — good prose is accepted', () => {
  const sweep = new ContextSweep();

  it('clean prose with strong signal produces a candidate', () => {
    const text = [
      'Human: I prefer using functional programming patterns in this project.',
      'The team decided to avoid classes and use plain functions with explicit state.',
    ].join('\n');
    const candidates = sweep.extractCandidates([makeStopEvent(text)]);
    assert.ok(candidates.length > 0, 'good prose should produce candidates');
  });

  it('a mix of code and prose where prose dominates is accepted', () => {
    // Code fence is small; the human message has strong signal in prose
    const text = [
      'Human: Remember this — we decided to always validate inputs before processing.',
      'Use `z.parse()` from zod.',
      'The decision was made after we found a bug in the original unvalidated path.',
    ].join('\n');
    const candidates = sweep.extractCandidates([makeStopEvent(text)]);
    assert.ok(candidates.length > 0, 'prose-dominant mix should produce candidates');
  });
});

// ---------------------------------------------------------------------------
// UserPromptSubmit path also respects the quality gate
// ---------------------------------------------------------------------------

describe('UserPromptSubmit quality gate', () => {
  const sweep = new ContextSweep();

  it('truncated user prompt is rejected', () => {
    const event = makeUserPromptEvent('Never skip the validation step...[truncated]');
    const candidates = sweep.extractCandidates([event]);
    assert.equal(candidates.length, 0, 'truncated user prompt should be rejected');
  });

  it('clean user prompt with strong signal is accepted', () => {
    const event = makeUserPromptEvent('Never skip the validation step — this is critical for security');
    const candidates = sweep.extractCandidates([event]);
    assert.ok(candidates.length > 0, 'clean user prompt with emphasis should be accepted');
  });
});
