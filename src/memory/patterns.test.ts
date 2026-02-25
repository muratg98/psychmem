/**
 * patterns.test.ts
 *
 * Targeted tests for the changes made to patterns.ts:
 *
 * PREFERENCE changes:
 *   - Removed 'like' and 'want' (too common in normal conversation)
 *   - Added 'I prefer', 'my preference', 'I dislike'
 *
 * BUG_FIX changes:
 *   - Removed generic terms: 'error', 'fix', 'fixed', 'issue', 'null',
 *     'undefined', 'fail', 'broken'
 *   - Kept specific compound terms only: 'TypeError', 'stack trace', etc.
 *
 * CORRECTION changes:
 *   - Removed 'actually' (too common in explanatory speech)
 *
 * CLASSIFICATION_PATTERNS mirrors:
 *   - Same removals/additions in the classification patterns
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  PREFERENCE,
  BUG_FIX,
  CORRECTION,
  matchPattern,
  matchAllPatterns,
  classifyByPatterns,
  CLASSIFICATION_PATTERNS,
} from './patterns.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns true when the pattern category matches the given text. */
function matches(text: string, category: typeof PREFERENCE): boolean {
  return matchPattern(text, category) !== null;
}

// ---------------------------------------------------------------------------
// PREFERENCE — removed words
// ---------------------------------------------------------------------------

describe('PREFERENCE — removed words no longer match', () => {
  // 'like' was removed because "I like that approach" or "I like TypeScript" are
  // ubiquitous and not memory-worthy by themselves.
  it('does NOT match standalone "like"', () => {
    assert.equal(matches('I like this approach', PREFERENCE), false);
    assert.equal(matches('I like TypeScript', PREFERENCE), false);
    assert.equal(matches('like this solution', PREFERENCE), false);
  });

  // 'want' was removed for the same reason.
  it('does NOT match standalone "want"', () => {
    assert.equal(matches('I want to add a feature', PREFERENCE), false);
    assert.equal(matches('want more tests', PREFERENCE), false);
  });
});

describe('PREFERENCE — new specific phrases match', () => {
  it('matches "I prefer"', () => {
    assert.equal(matches('I prefer tabs over spaces', PREFERENCE), true);
  });

  it('matches "my preference"', () => {
    assert.equal(matches('My preference is to use Bun', PREFERENCE), true);
  });

  it('matches "I dislike"', () => {
    assert.equal(matches('I dislike verbose APIs', PREFERENCE), true);
  });

  // Existing keywords that must still work
  it('still matches "prefer" (without "I ")', () => {
    assert.equal(matches('prefer functional style', PREFERENCE), true);
  });

  it('still matches "avoid"', () => {
    assert.equal(matches('avoid mutable state', PREFERENCE), true);
  });

  it("still matches \"don't like\"", () => {
    assert.equal(matches("I don't like nested callbacks", PREFERENCE), true);
  });
});

// ---------------------------------------------------------------------------
// BUG_FIX — removed generic words
// ---------------------------------------------------------------------------

describe('BUG_FIX — removed generic words no longer match', () => {
  it('does NOT match standalone "error"', () => {
    assert.equal(matches('there was an error', BUG_FIX), false);
    assert.equal(matches('error handling', BUG_FIX), false);
  });

  it('does NOT match standalone "fix"', () => {
    assert.equal(matches('fix the styling', BUG_FIX), false);
  });

  it('does NOT match "fixed"', () => {
    assert.equal(matches('I fixed the tests', BUG_FIX), false);
  });

  it('does NOT match "issue"', () => {
    assert.equal(matches('there is an issue with the config', BUG_FIX), false);
  });

  it('does NOT match "null"', () => {
    assert.equal(matches('value is null', BUG_FIX), false);
  });

  it('does NOT match "undefined"', () => {
    assert.equal(matches('variable is undefined', BUG_FIX), false);
  });

  it('does NOT match "fail"', () => {
    assert.equal(matches('the test will fail', BUG_FIX), false);
  });

  it('does NOT match "broken"', () => {
    assert.equal(matches('something is broken', BUG_FIX), false);
  });
});

describe('BUG_FIX — specific compound terms still match', () => {
  it('matches "found a bug"', () => {
    assert.equal(matches('I found a bug in the parser', BUG_FIX), true);
  });

  it('matches "TypeError"', () => {
    assert.equal(matches('TypeError: Cannot read property of undefined', BUG_FIX), true);
  });

  it('matches "stack trace"', () => {
    assert.equal(matches('here is the stack trace from the crash', BUG_FIX), true);
  });

  it('matches "workaround"', () => {
    assert.equal(matches('used a workaround for the SQLite issue', BUG_FIX), true);
  });

  it('matches "hotfix"', () => {
    assert.equal(matches('deployed a hotfix to production', BUG_FIX), true);
  });

  it('matches "crash on"', () => {
    assert.equal(matches('crash on startup when config is missing', BUG_FIX), true);
  });

  it('matches "segfault"', () => {
    assert.equal(matches('segfault in the native module', BUG_FIX), true);
  });

  it('matches "memory leak"', () => {
    assert.equal(matches('there is a memory leak in the event loop', BUG_FIX), true);
  });
});

// ---------------------------------------------------------------------------
// CORRECTION — 'actually' removed
// ---------------------------------------------------------------------------

describe('CORRECTION — "actually" no longer matches', () => {
  it('does NOT match "actually" alone', () => {
    assert.equal(matches('actually this is how it works', CORRECTION), false);
    assert.equal(matches('Actually, TypeScript handles this', CORRECTION), false);
  });

  // Make sure other correction words still fire
  it('still matches "no," correction', () => {
    assert.equal(matches('no, that is wrong', CORRECTION), true);
  });

  it('still matches "wait"', () => {
    assert.equal(matches('wait, I made a mistake', CORRECTION), true);
  });

  it('still matches "scratch that"', () => {
    assert.equal(matches('scratch that, use a different approach', CORRECTION), true);
  });
});

// ---------------------------------------------------------------------------
// matchAllPatterns — interaction between categories
// ---------------------------------------------------------------------------

describe('matchAllPatterns — removed words do not produce signals', () => {
  it('plain "I like this" produces no signals', () => {
    const signals = matchAllPatterns('I like this');
    // Should not contain a preference signal triggered by 'like'
    const prefSignals = signals.filter(s => s.type === 'preference');
    assert.equal(prefSignals.length, 0);
  });

  it('plain "error in the code" produces no signals', () => {
    const signals = matchAllPatterns('error in the code');
    const bugSignals = signals.filter(s => s.type === 'bug_fix');
    assert.equal(bugSignals.length, 0);
  });

  it('"actually I see now" still produces a learning signal (not correction)', () => {
    const signals = matchAllPatterns('actually I see now how this works');
    // 'I see now' is a LEARNING keyword → should produce learning signal
    const learningSignals = signals.filter(s => s.type === 'learning');
    assert.ok(learningSignals.length > 0, 'expected a learning signal from "I see now"');
    // Should NOT produce a correction signal from 'actually'
    const correctionSignals = signals.filter(s => s.type === 'correction');
    assert.equal(correctionSignals.length, 0);
  });
});

// ---------------------------------------------------------------------------
// classifyByPatterns — CLASSIFICATION_PATTERNS mirrors
// ---------------------------------------------------------------------------

describe('classifyByPatterns — mirrors patterns.ts changes', () => {
  it('classifies "I prefer tabs" as preference', () => {
    assert.equal(classifyByPatterns('I prefer tabs over spaces'), 'preference');
  });

  it('classifies "my preference is Bun" as preference', () => {
    assert.equal(classifyByPatterns('my preference is to use Bun'), 'preference');
  });

  it('does NOT classify "I like this" as preference', () => {
    // 'like' was removed from CLASSIFICATION_PATTERNS.preference.latin
    assert.notEqual(classifyByPatterns('I like this'), 'preference');
  });

  it('classifies "TypeError: ..." as bugfix', () => {
    assert.equal(classifyByPatterns('TypeError: Cannot read properties'), 'bugfix');
  });

  it('classifies "found a bug" as bugfix', () => {
    assert.equal(classifyByPatterns('found a bug in the router'), 'bugfix');
  });

  it('does NOT classify standalone "error" as bugfix', () => {
    // 'error' alone was removed from classification patterns
    assert.notEqual(classifyByPatterns('there was an error'), 'bugfix');
  });

  it('classifies "I decided to use React" as decision', () => {
    assert.equal(classifyByPatterns('I decided to use React for the UI'), 'decision');
  });

  it('classifies "cannot use eval" as constraint', () => {
    assert.equal(classifyByPatterns("cannot use eval here"), 'constraint');
  });
});

// ---------------------------------------------------------------------------
// Weight sanity check
// ---------------------------------------------------------------------------

describe('Pattern weights', () => {
  it('PREFERENCE weight is 0.6', () => {
    assert.equal(PREFERENCE.weight, 0.6);
  });

  it('BUG_FIX weight is 0.8', () => {
    assert.equal(BUG_FIX.weight, 0.8);
  });

  it('CORRECTION weight is 0.7', () => {
    assert.equal(CORRECTION.weight, 0.7);
  });
});
