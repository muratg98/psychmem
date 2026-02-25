/**
 * Selective Memory - Stage 2 of the selective memory pipeline
 * 
 * Scores memory candidates using psych + math features:
 * - Recency, Frequency, Importance, Utility, Novelty, Confidence, Interference
 * 
 * Handles:
 * - Rule-based scoring (v1)
 * - STM/LTM allocation
 * - Consolidation (STM → LTM promotion)
 */

import type {
  MemoryUnit,
  MemoryCandidate,
  MemoryStore,
  MemoryClassification,
  MemoryFeatureVector,
  ScoringWeights,
  PsychMemConfig,
} from '../types/index.js';
import { DEFAULT_CONFIG, isUserLevelClassification } from '../types/index.js';
import { MemoryDatabase } from '../storage/database.js';
import { EmbeddingService } from '../embeddings/index.js';

export class SelectiveMemory {
  private db: MemoryDatabase;
  private config: PsychMemConfig;

  constructor(db: MemoryDatabase, config: Partial<PsychMemConfig> = {}) {
    this.db = db;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ===========================================================================
  // Memory Allocation (STM vs LTM)
  // ===========================================================================

  /**
   * Process memory candidates and allocate to STM or LTM
   * @param candidates Memory candidates to process
   * @param options Optional processing options (e.g., sessionId for deduplication tracking, projectScope for v1.6)
   */
  processCandidates(
    candidates: MemoryCandidate[],
    options?: { sessionId?: string; projectScope?: string }
  ): MemoryUnit[] {
    const createdMemories: MemoryUnit[] = [];

    // Load existing memories once: used for global dedup, novelty, and interference checks
    const existingMemories = this.db.getTopMemories(200);

    for (const candidate of candidates) {
      // Bug B fix: skip if a near-duplicate already exists in the DB (Jaccard >= 0.7)
      const isDuplicate = existingMemories.some(
        mem => this.calculateTextSimilarity(candidate.summary, mem.summary) >= 0.7
      );
      if (isDuplicate) continue;

      // Check if this should auto-promote to LTM
      const shouldAutoPromote = this.config.autoPromoteToLtm.includes(candidate.classification);
      
      // Calculate initial store
      const store: MemoryStore = shouldAutoPromote ? 'ltm' : 'stm';
      
      // Calculate feature scores (passes cached list to avoid redundant DB queries)
      const features = this.calculateFeatures(candidate, existingMemories);
      
      // Calculate initial strength
      const strength = this.calculateStrength(features);
      
      // Check for interference with existing memories
      const interference = this.detectInterference(candidate, existingMemories);
      
      // Determine project scope based on classification (v1.6)
      // User-level memories (constraint, preference, learning, procedural) don't have a project scope
      // Project-level memories (decision, bugfix, episodic, semantic) get the current project scope
      const memoryProjectScope = isUserLevelClassification(candidate.classification) 
        ? undefined 
        : options?.projectScope;
      
      // Create the memory unit
      const memory = this.db.createMemory(
        store,
        candidate.classification,
        candidate.summary,
        candidate.sourceEventIds,
        {
          ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
          ...(memoryProjectScope ? { projectScope: memoryProjectScope } : {}),
          importance: candidate.preliminaryImportance,
          utility: 0.5, // Will be updated based on usage
          novelty: features.novelty,
          confidence: candidate.confidence,
          tags: this.extractTags(candidate),
        }
      );

      // Update with interference if detected
      if (interference > 0) {
        this.db.updateMemoryStrength(memory.id, strength * (1 - interference * 0.2));
      }

      createdMemories.push(memory);
    }

    // Fire-and-forget: generate embeddings for newly created memories.
    // Runs async so it doesn't block the synchronous extraction pipeline.
    // Any failure is silently swallowed — retrieval falls back to Jaccard.
    if (createdMemories.length > 0) {
      void embedMemoriesAsync(createdMemories, this.db);
    }

    return createdMemories;
  }

  /**
   * Calculate feature vector for a candidate
   */
  private calculateFeatures(candidate: MemoryCandidate, existingMemories: MemoryUnit[]): MemoryFeatureVector {
    return {
      recency: 0, // Just created
      frequency: 1, // First occurrence
      importance: candidate.preliminaryImportance,
      utility: 0.5, // Unknown until used
      novelty: this.calculateNovelty(candidate, existingMemories),
      confidence: candidate.confidence,
      interference: 0, // Calculated separately
    };
  }

  /**
   * Calculate novelty score based on similarity to existing memories
   */
  private calculateNovelty(candidate: MemoryCandidate, existingMemories: MemoryUnit[]): number {
    if (existingMemories.length === 0) {
      return 1.0; // Everything is novel when memory is empty
    }

    // Calculate similarity to existing memories
    let maxSimilarity = 0;
    for (const mem of existingMemories) {
      const similarity = this.calculateTextSimilarity(candidate.summary, mem.summary);
      maxSimilarity = Math.max(maxSimilarity, similarity);
    }

    // Novelty is inverse of similarity
    return 1 - maxSimilarity;
  }

  /**
   * Detect interference with existing memories
   */
  private detectInterference(candidate: MemoryCandidate, existingMemories: MemoryUnit[]): number {
    // Look for conflicting information
    let interference = 0;
    
    for (const mem of existingMemories) {
      // Check for potential conflicts (same topic, different content)
      const topicSimilarity = this.calculateTextSimilarity(candidate.summary, mem.summary);
      
      if (topicSimilarity > 0.3 && topicSimilarity < 0.8) {
        // Similar topic but different content = potential conflict
        interference = Math.max(interference, topicSimilarity * 0.5);
      }
    }

    return interference;
  }

  /**
   * Calculate strength from feature vector (rule-based v1)
   */
  calculateStrength(features: MemoryFeatureVector): number {
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
  // Consolidation (STM → LTM)
  // ===========================================================================

  /**
   * Check and promote eligible STM memories to LTM
   * Based on:
   * - Strength threshold
   * - Frequency threshold
   * - Auto-promote classifications
   */
  runConsolidation(): ConsolidationResult {
    const stmMemories = this.db.getMemoriesByStore('stm');
    const result: ConsolidationResult = {
      promoted: [],
      decayed: [],
      unchanged: [],
    };

    for (const mem of stmMemories) {
      // Check promotion criteria
      const shouldPromote = this.shouldPromoteToLtm(mem);
      
      if (shouldPromote) {
        this.db.promoteToLtm(mem.id);
        result.promoted.push(mem.id);
      } else if (mem.strength < 0.1) {
        // Too weak, mark as decayed
        this.db.updateMemoryStatus(mem.id, 'decayed');
        result.decayed.push(mem.id);
      } else {
        result.unchanged.push(mem.id);
      }
    }

    return result;
  }

  /**
   * Determine if a memory should be promoted to LTM
   */
  private shouldPromoteToLtm(memory: MemoryUnit): boolean {
    // Auto-promote certain classifications
    if (this.config.autoPromoteToLtm.includes(memory.classification)) {
      return true;
    }

    // Promote based on strength
    if (memory.strength >= this.config.stmToLtmStrengthThreshold) {
      return true;
    }

    // Promote based on frequency (spaced repetition)
    if (memory.frequency >= this.config.stmToLtmFrequencyThreshold) {
      return true;
    }

    return false;
  }

  // ===========================================================================
  // Decay Management
  // ===========================================================================

  /**
   * Apply exponential decay to all memories
   * strength_t = strength_0 * exp(-lambda * dt)
   */
  applyDecay(): DecayResult {
    const decayedCount = this.db.applyDecay();
    return {
      memoriesDecayed: decayedCount,
      timestamp: new Date(),
    };
  }

  /**
   * Simple text similarity (Jaccard index)
   */
  private calculateTextSimilarity(a: string, b: string): number {
    const wordsA = new Set(a.toLowerCase().split(/\s+/));
    const wordsB = new Set(b.toLowerCase().split(/\s+/));
    
    const intersection = new Set([...wordsA].filter(x => wordsB.has(x)));
    const union = new Set([...wordsA, ...wordsB]);
    
    return union.size === 0 ? 0 : intersection.size / union.size;
  }

  /**
   * Extract tags from candidate
   */
  private extractTags(candidate: MemoryCandidate): string[] {
    const tags: string[] = [candidate.classification];
    
    // Add signal-based tags
    for (const signal of candidate.importanceSignals) {
      if (!tags.includes(signal.type)) {
        tags.push(signal.type);
      }
    }
    
    return tags;
  }
}

// ===========================================================================
// Result Types
// ===========================================================================

export interface ConsolidationResult {
  promoted: string[];
  decayed: string[];
  unchanged: string[];
}

export interface DecayResult {
  memoriesDecayed: number;
  timestamp: Date;
}

// ===========================================================================
// Embedding helpers
// ===========================================================================

/**
 * Generate and persist embeddings for a list of newly created memories.
 *
 * This is intentionally async / fire-and-forget: the synchronous extraction
 * pipeline doesn't wait for embeddings to be ready.  Retrieval falls back to
 * Jaccard similarity for memories that don't yet have an embedding.
 */
async function embedMemoriesAsync(
  memories: MemoryUnit[],
  db: MemoryDatabase
): Promise<void> {
  try {
    const texts = memories.map(m => m.summary);
    const embeddings = await EmbeddingService.embedBatch(texts);
    for (let i = 0; i < memories.length; i++) {
      db.setMemoryEmbedding(memories[i]!.id, embeddings[i]!);
    }
  } catch {
    // Silently ignore — retrieval has a Jaccard fallback.
  }
}
