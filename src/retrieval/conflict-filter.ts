/**
 * Conflict / Reconsolidation Filter
 *
 * Before memories are injected into a session, this pass detects conflicting
 * pairs and suppresses the weaker one.  This mirrors the human reconsolidation
 * phase: contradictory beliefs are resolved toward the stronger / more recent
 * memory so stale decisions don't pollute new sessions.
 *
 * Detection strategy (no embeddings required):
 *   1. Topic overlap — Jaccard similarity on word sets >= TOPIC_OVERLAP_THRESHOLD
 *      means both memories are about the same subject.
 *   2. Polarity opposition — one memory contains a positive polarity word and
 *      the other contains its antonym (e.g. "use" vs "avoid", "prefer" vs
 *      "dislike", "never" vs "always").
 *
 * If both conditions hold, the pair is considered conflicting.  The memory
 * with lower `strength` is suppressed.  Equal strength → prefer the newer one
 * (lower createdAt timestamp = older → suppress).
 *
 * The suppressed memories are returned separately so callers can optionally
 * log them (e.g. as "historical" context).
 */

import type { MemoryUnit } from '../types/index.js';

export interface ConflictFilterResult {
  /** Memories safe to inject — conflicts resolved. */
  clean: MemoryUnit[];
  /** Memories that were suppressed due to a conflict with a stronger memory. */
  suppressed: Array<{ memory: MemoryUnit; conflictsWith: string }>;
}

/**
 * Minimum Jaccard word-overlap to consider two memories to be about the same
 * topic.  0.25 is intentionally loose — we're looking for thematic proximity,
 * not exact duplicates (the dedup layer handles those separately).
 */
const TOPIC_OVERLAP_THRESHOLD = 0.25;

/**
 * Opposing polarity word pairs.  If one memory contains a word from group A
 * and the other contains the corresponding word from group B, they are
 * considered polar opposites on the same topic.
 */
const POLARITY_PAIRS: Array<[string[], string[]]> = [
  [['never', 'avoid', 'dislike', "don't use", 'do not use', 'stop using', 'remove'],
   ['always', 'use', 'prefer', 'adopt', 'start using', 'add', 'keep']],
  [['deprecated', 'outdated', 'old'],
   ['current', 'latest', 'new', 'modern']],
  [['disable', 'turn off', 'skip'],
   ['enable', 'turn on', 'run']],
  [['reject', 'block', 'forbid'],
   ['accept', 'allow', 'permit']],
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the conflict filter over a list of memories.
 *
 * The input list should already be sorted in injection-priority order
 * (STM-first, then LTM, within-tier by relevance).  When a conflicting pair
 * is found, the lower-priority member (later in the list) is suppressed.
 *
 * This is O(n²) but n is always ≤ 7 (the injection budget cap), so it's fine.
 */
export function filterConflicts(memories: MemoryUnit[]): ConflictFilterResult {
  const suppressed: ConflictFilterResult['suppressed'] = [];
  const suppressedIds = new Set<string>();

  for (let i = 0; i < memories.length; i++) {
    if (suppressedIds.has(memories[i]!.id)) continue;

    for (let j = i + 1; j < memories.length; j++) {
      if (suppressedIds.has(memories[j]!.id)) continue;

      const a = memories[i]!;
      const b = memories[j]!;

      if (areConflicting(a, b)) {
        // Suppress the weaker one.  If equal strength, suppress the older one
        // (b comes later in the priority-sorted list, which means lower priority;
        // suppress b as a safe default when strength is equal too).
        const loser = chooseLoser(a, b);
        suppressedIds.add(loser.id);
        const winner = loser.id === a.id ? b : a;
        suppressed.push({ memory: loser, conflictsWith: winner.summary.slice(0, 80) });
      }
    }
  }

  return {
    clean: memories.filter(m => !suppressedIds.has(m.id)),
    suppressed,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function areConflicting(a: MemoryUnit, b: MemoryUnit): boolean {
  const topicOverlap = jaccardSimilarity(a.summary, b.summary);
  if (topicOverlap < TOPIC_OVERLAP_THRESHOLD) return false;

  return hasOpposingPolarity(a.summary, b.summary);
}

function hasOpposingPolarity(textA: string, textB: string): boolean {
  const lower_a = textA.toLowerCase();
  const lower_b = textB.toLowerCase();

  for (const [groupA, groupB] of POLARITY_PAIRS) {
    const aHasA = groupA.some(w => lower_a.includes(w));
    const aHasB = groupB.some(w => lower_a.includes(w));
    const bHasA = groupA.some(w => lower_b.includes(w));
    const bHasB = groupB.some(w => lower_b.includes(w));

    // One text expresses the "A" side and the other expresses the "B" side.
    if ((aHasA && bHasB) || (aHasB && bHasA)) return true;
  }

  return false;
}

function chooseLoser(a: MemoryUnit, b: MemoryUnit): MemoryUnit {
  if (a.strength !== b.strength) {
    return a.strength < b.strength ? a : b;
  }
  // Equal strength: suppress the older memory (smaller createdAt = older).
  return a.createdAt < b.createdAt ? a : b;
}

function jaccardSimilarity(textA: string, textB: string): number {
  const wordsA = new Set(
    textA.toLowerCase().split(/\s+/).filter(w => w.length > 2)
  );
  const wordsB = new Set(
    textB.toLowerCase().split(/\s+/).filter(w => w.length > 2)
  );

  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  const intersection = new Set([...wordsA].filter(x => wordsB.has(x)));
  const union = new Set([...wordsA, ...wordsB]);

  return intersection.size / union.size;
}
