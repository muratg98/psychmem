/**
 * structural-analyzer.test.ts
 *
 * Targeted tests for weight changes made to structural-analyzer.ts:
 *
 *   code_block  : 0.4  → 0.25  (code alone is not memory-worthy)
 *   definition  : 0.4  → 0.3   (colon-based definitions)
 *   file_path   : 0.4  → 0.25  (file paths alone are not memory-worthy)
 *   url         : 0.3  → 0.2   (URLs alone are not memory-worthy)
 *
 * The key invariant after these changes: a single structural signal that
 * was previously above the signalThreshold of 0.5 may now fall below it,
 * so a code block or file path alone can no longer trigger memory extraction.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  analyzeTypography,
  analyzeDiscourseMarkers,
  analyzeMetaSignals,
  type ChunkContext,
  type ConversationContext,
} from './structural-analyzer.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChunk(text: string, index = 0): ChunkContext {
  return { text, index };
}

function makeContext(chunks: ChunkContext[]): ConversationContext {
  return { chunks };
}

// ---------------------------------------------------------------------------
// code_block weight = 0.25
// ---------------------------------------------------------------------------

describe('code_block signal weight is 0.25', () => {
  it('emits code_block signal with weight 0.25 for fenced code', () => {
    const signals = analyzeTypography('```\nconst x = 1;\n```');
    const codeSignal = signals.find(s => s.type === 'code_block');
    assert.ok(codeSignal, 'expected a code_block signal');
    assert.equal(codeSignal.weight, 0.25);
  });

  it('emits code_block signal with weight 0.25 for inline code', () => {
    const signals = analyzeTypography('Use `npm install` to set up');
    const codeSignal = signals.find(s => s.type === 'code_block');
    assert.ok(codeSignal, 'expected a code_block signal');
    assert.equal(codeSignal.weight, 0.25);
  });

  it('code_block weight is below default signalThreshold of 0.5', () => {
    const signals = analyzeTypography('```\nconst x = 1;\n```');
    const codeSignal = signals.find(s => s.type === 'code_block');
    assert.ok(codeSignal);
    assert.ok(
      codeSignal.weight < 0.5,
      `code_block weight ${codeSignal.weight} should be below 0.5 threshold`
    );
  });
});

// ---------------------------------------------------------------------------
// definition weight = 0.3
// ---------------------------------------------------------------------------

describe('definition (colon-based) signal weight is 0.3', () => {
  it('emits structural_enumeration signal with weight 0.3 for "Term: definition"', () => {
    const signals = analyzeDiscourseMarkers('Config: the main configuration object');
    const defSignal = signals.find(s => s.source === 'definition');
    assert.ok(defSignal, 'expected a definition signal');
    assert.equal(defSignal.weight, 0.3);
  });

  it('definition weight is below default signalThreshold of 0.5', () => {
    const signals = analyzeDiscourseMarkers('Config: something here');
    const defSignal = signals.find(s => s.source === 'definition');
    assert.ok(defSignal);
    assert.ok(
      defSignal.weight < 0.5,
      `definition weight ${defSignal.weight} should be below 0.5 threshold`
    );
  });
});

// ---------------------------------------------------------------------------
// file_path weight = 0.25
// ---------------------------------------------------------------------------

describe('file_path signal weight is 0.25', () => {
  it('emits meta_reference signal with weight 0.25 for Unix path', () => {
    const chunk = makeChunk('/home/user/projects/foo/bar.ts');
    const ctx = makeContext([chunk]);
    const signals = analyzeMetaSignals(chunk, ctx);
    const pathSignal = signals.find(s => s.source === 'file_path');
    assert.ok(pathSignal, 'expected a file_path signal');
    assert.equal(pathSignal.weight, 0.25);
  });

  it('emits meta_reference signal with weight 0.25 for Windows path', () => {
    const chunk = makeChunk('C:\\Users\\MGRyko\\Projects\\psychmem\\src\\core.ts');
    const ctx = makeContext([chunk]);
    const signals = analyzeMetaSignals(chunk, ctx);
    const pathSignal = signals.find(s => s.source === 'file_path');
    assert.ok(pathSignal, 'expected a file_path signal');
    assert.equal(pathSignal.weight, 0.25);
  });

  it('file_path weight is below default signalThreshold of 0.5', () => {
    const chunk = makeChunk('/src/memory/patterns.ts');
    const ctx = makeContext([chunk]);
    const signals = analyzeMetaSignals(chunk, ctx);
    const pathSignal = signals.find(s => s.source === 'file_path');
    assert.ok(pathSignal);
    assert.ok(
      pathSignal.weight < 0.5,
      `file_path weight ${pathSignal.weight} should be below 0.5 threshold`
    );
  });
});

// ---------------------------------------------------------------------------
// url weight = 0.2
// ---------------------------------------------------------------------------

describe('url signal weight is 0.2', () => {
  it('emits meta_reference signal with weight 0.2 for https URL', () => {
    const chunk = makeChunk('See https://example.com/docs for more info');
    const ctx = makeContext([chunk]);
    const signals = analyzeMetaSignals(chunk, ctx);
    const urlSignal = signals.find(s => s.source === 'url');
    assert.ok(urlSignal, 'expected a url signal');
    assert.equal(urlSignal.weight, 0.2);
  });

  it('emits meta_reference signal with weight 0.2 for http URL', () => {
    const chunk = makeChunk('Reference: http://localhost:3000/api');
    const ctx = makeContext([chunk]);
    const signals = analyzeMetaSignals(chunk, ctx);
    const urlSignal = signals.find(s => s.source === 'url');
    assert.ok(urlSignal, 'expected a url signal');
    assert.equal(urlSignal.weight, 0.2);
  });

  it('url weight is below default signalThreshold of 0.5', () => {
    const chunk = makeChunk('Check https://docs.example.com');
    const ctx = makeContext([chunk]);
    const signals = analyzeMetaSignals(chunk, ctx);
    const urlSignal = signals.find(s => s.source === 'url');
    assert.ok(urlSignal);
    assert.ok(
      urlSignal.weight < 0.5,
      `url weight ${urlSignal.weight} should be below 0.5 threshold`
    );
  });
});

// ---------------------------------------------------------------------------
// High-weight signals remain above threshold
// ---------------------------------------------------------------------------

describe('high-weight signals remain above 0.5 threshold', () => {
  it('ALL_CAPS emphasis signal is >= 0.5', () => {
    const signals = analyzeTypography('IMPORTANT: DO NOT DELETE THIS FILE');
    const capsSignal = signals.find(s => s.source === 'ALL_CAPS');
    assert.ok(capsSignal, 'expected an ALL_CAPS signal');
    assert.ok(capsSignal.weight >= 0.5, `expected >= 0.5, got ${capsSignal.weight}`);
  });

  it('markdown_emphasis signal weight is 0.6 (above threshold)', () => {
    const signals = analyzeTypography('This is **very important** to remember');
    const boldSignal = signals.find(s => s.source === 'markdown_emphasis');
    assert.ok(boldSignal, 'expected a markdown_emphasis signal');
    assert.equal(boldSignal.weight, 0.6);
  });

  it('stack_trace signal weight is 0.7 (well above threshold)', () => {
    const text = 'Error: something went wrong\n  at MyFunc (/src/core.ts:42:5)';
    const chunk = makeChunk(text);
    const ctx = makeContext([chunk]);
    const signals = analyzeMetaSignals(chunk, ctx);
    const stackSignal = signals.find(s => s.source === 'stack_trace');
    assert.ok(stackSignal, 'expected a stack_trace signal');
    assert.equal(stackSignal.weight, 0.7);
  });

  it('arrow discourse marker weight is 0.5 (at threshold)', () => {
    const signals = analyzeDiscourseMarkers('step one → step two → done');
    const arrowSignal = signals.find(s => s.source === 'arrow');
    assert.ok(arrowSignal, 'expected an arrow signal');
    assert.equal(arrowSignal.weight, 0.5);
  });
});

// ---------------------------------------------------------------------------
// Regression: text with only low-weight signals
// ---------------------------------------------------------------------------

describe('text with only low-weight structural signals', () => {
  it('produces no signals at or above 0.5 for a plain URL-only message', () => {
    const chunk = makeChunk('https://example.com/page');
    const ctx = makeContext([chunk]);
    const urlSignals = analyzeMetaSignals(chunk, ctx);
    const aboveThreshold = urlSignals.filter(s => s.weight >= 0.5);
    assert.equal(
      aboveThreshold.length,
      0,
      'URL alone should not produce signals >= 0.5'
    );
  });

  it('produces no signals at or above 0.5 for inline code only', () => {
    const signals = analyzeTypography('Run `npm install` first');
    const aboveThreshold = signals.filter(s => s.weight >= 0.5);
    assert.equal(
      aboveThreshold.length,
      0,
      'Inline code alone should not produce signals >= 0.5'
    );
  });

  it('produces no signals at or above 0.5 for a file path only', () => {
    const chunk = makeChunk('/src/index.ts is the entry point');
    const ctx = makeContext([chunk]);
    const signals = analyzeMetaSignals(chunk, ctx);
    const aboveThreshold = signals.filter(s => s.weight >= 0.5);
    assert.equal(
      aboveThreshold.length,
      0,
      'File path alone should not produce signals >= 0.5'
    );
  });
});
