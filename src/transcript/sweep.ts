/**
 * Transcript Sweep - Memory extraction from transcript with deduplication
 * 
 * This module coordinates:
 * 1. Parsing new transcript entries (using watermark)
 * 2. Running context sweep on new content
 * 3. Deduplicating against existing session memories (70% keyword overlap)
 * 4. Limiting to maxMemoriesPerStop (based on Cowan's working memory: 4±1)
 */

import type {
  MemoryCandidate,
  MemoryUnit,
  PsychMemConfig,
} from '../types/index.js';
import { TranscriptParser, type TranscriptEntry } from './parser.js';
import { ContextSweep } from '../memory/context-sweep.js';
import { DEFAULT_CONFIG } from '../types/index.js';

// =============================================================================
// Types
// =============================================================================

export interface TranscriptSweepResult {
  /** Memory candidates after deduplication */
  candidates: MemoryCandidate[];
  /** New watermark to save */
  newWatermark: number;
  /** Number of candidates before deduplication */
  rawCandidateCount: number;
  /** Number filtered by deduplication */
  deduplicatedCount: number;
  /** Number filtered by limit */
  limitedCount: number;
}

export interface TranscriptSweepOptions {
  /** Session ID for deduplication lookup */
  sessionId: string;
  /** Existing memories for this session */
  existingMemories: MemoryUnit[];
  /** Configuration */
  config?: Partial<PsychMemConfig>;
}

// =============================================================================
// Transcript Sweep Implementation
// =============================================================================

export class TranscriptSweep {
  private parser: TranscriptParser;
  private contextSweep: ContextSweep;
  private config: PsychMemConfig;

  constructor(config: Partial<PsychMemConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.parser = new TranscriptParser();
    this.contextSweep = new ContextSweep(this.config.sweep);
  }

  /**
   * Main entry point: extract memories from transcript since last watermark
   * with deduplication and limits
   */
  async sweepTranscript(
    transcriptPath: string,
    watermark: number,
    options: TranscriptSweepOptions
  ): Promise<TranscriptSweepResult> {
    // 1. Parse new transcript entries
    const parseResult = await this.parser.parseFromWatermark(transcriptPath, watermark);
    
    if (parseResult.entries.length === 0) {
      return {
        candidates: [],
        newWatermark: parseResult.newWatermark,
        rawCandidateCount: 0,
        deduplicatedCount: 0,
        limitedCount: 0,
      };
    }

    // 2. Convert entries to conversation text and run context sweep
    const conversationText = TranscriptParser.entriesToConversationText(parseResult.entries);
    const rawCandidates = this.extractFromText(conversationText, parseResult.entries);

    // 3. Deduplicate against existing session memories
    const dedupResult = this.deduplicateCandidates(
      rawCandidates,
      options.existingMemories
    );

    // 4. Apply limit (maxMemoriesPerStop)
    const limited = this.applyLimit(dedupResult.candidates);

    return {
      candidates: limited.candidates,
      newWatermark: parseResult.newWatermark,
      rawCandidateCount: rawCandidates.length,
      deduplicatedCount: dedupResult.removedCount,
      limitedCount: limited.removedCount,
    };
  }

  /**
   * Extract memory candidates from conversation text
   * Creates synthetic events for context sweep compatibility.
   * Only user_message and assistant_message entries are turned into events —
   * tool_use / tool_result entries contain raw file/grep/diff output that
   * fires patterns on irrelevant tokens and produces junk memories.
   */
  private extractFromText(
    text: string,
    entries: TranscriptEntry[]
  ): MemoryCandidate[] {
    // Filter to conversational turns only; skip tool I/O entries
    const conversationalEntries = entries.filter(
      e => e.type === 'user_message' || e.type === 'assistant_message'
    );

    // Create synthetic events for the context sweep
    const syntheticEvents = conversationalEntries.map((entry, index) => ({
      id: `transcript-${index}`,
      sessionId: 'transcript',
      hookType: this.entryTypeToHookType(entry.type),
      timestamp: entry.timestamp ? new Date(entry.timestamp) : new Date(),
      content: entry.content,
      toolName: entry.toolName,
      toolInput: entry.toolInput ? JSON.stringify(entry.toolInput) : undefined,
      toolOutput: entry.toolOutput ? JSON.stringify(entry.toolOutput) : undefined,
    }));

    // Also add a Stop event with full conversation for comprehensive analysis
    syntheticEvents.push({
      id: 'transcript-stop',
      sessionId: 'transcript',
      hookType: 'Stop' as const,
      timestamp: new Date(),
      content: text,
      toolName: undefined,
      toolInput: undefined,
      toolOutput: undefined,
    });

    // Run context sweep
    return this.contextSweep.extractCandidates(syntheticEvents);
  }

  /**
   * Map transcript entry type to hook type for context sweep
   */
  private entryTypeToHookType(type: TranscriptEntry['type']): 'UserPromptSubmit' | 'PostToolUse' | 'Stop' {
    switch (type) {
      case 'user_message':
        return 'UserPromptSubmit';
      case 'tool_use':
      case 'tool_result':
        return 'PostToolUse';
      default:
        return 'Stop';
    }
  }

  /**
   * Deduplicate candidates against existing memories using keyword overlap
   */
  private deduplicateCandidates(
    candidates: MemoryCandidate[],
    existingMemories: MemoryUnit[]
  ): { candidates: MemoryCandidate[]; removedCount: number } {
    if (existingMemories.length === 0) {
      return { candidates, removedCount: 0 };
    }

    // Pre-compute keywords for existing memories
    const existingKeywordSets = existingMemories.map(mem => ({
      memory: mem,
      keywords: this.extractKeywords(mem.summary),
    }));

    const filtered: MemoryCandidate[] = [];
    let removedCount = 0;

    for (const candidate of candidates) {
      const candidateKeywords = this.extractKeywords(candidate.summary);
      
      // Check overlap with each existing memory
      let isDuplicate = false;
      
      for (const { keywords: existingKeywords } of existingKeywordSets) {
        const overlap = this.calculateKeywordOverlap(candidateKeywords, existingKeywords);
        
        if (overlap >= this.config.deduplicationThreshold) {
          isDuplicate = true;
          break;
        }
      }

      if (isDuplicate) {
        removedCount++;
      } else {
        filtered.push(candidate);
      }
    }

    return { candidates: filtered, removedCount };
  }

  /**
   * Apply the max memories per stop limit
   * Sort by importance and take top N
   */
  private applyLimit(
    candidates: MemoryCandidate[]
  ): { candidates: MemoryCandidate[]; removedCount: number } {
    if (candidates.length <= this.config.maxMemoriesPerStop) {
      return { candidates, removedCount: 0 };
    }

    // Sort by preliminary importance (descending)
    const sorted = [...candidates].sort(
      (a, b) => b.preliminaryImportance - a.preliminaryImportance
    );

    const limited = sorted.slice(0, this.config.maxMemoriesPerStop);
    const removedCount = candidates.length - limited.length;

    return { candidates: limited, removedCount };
  }

  /**
   * Extract keywords from text for overlap calculation
   * Returns a Set of normalized keywords
   */
  private extractKeywords(text: string): Set<string> {
    // Stopwords to filter out
    const stopwords = new Set([
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
      'should', 'may', 'might', 'can', 'to', 'of', 'in', 'for', 'on', 'with',
      'at', 'by', 'from', 'as', 'into', 'through', 'during', 'before', 'after',
      'this', 'that', 'these', 'those', 'it', 'its', 'they', 'them', 'their',
      'and', 'or', 'but', 'if', 'so', 'because', 'while', 'when', 'where',
      'what', 'which', 'who', 'how', 'why', 'all', 'each', 'some', 'any',
      'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'she', 'him', 'her',
    ]);

    const words = text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 2 && !stopwords.has(word));

    return new Set(words);
  }

  /**
   * Calculate Jaccard similarity (overlap) between two keyword sets
   * Returns a value between 0 and 1
   */
  private calculateKeywordOverlap(setA: Set<string>, setB: Set<string>): number {
    if (setA.size === 0 || setB.size === 0) {
      return 0;
    }

    let intersection = 0;
    for (const word of setA) {
      if (setB.has(word)) {
        intersection++;
      }
    }

    const union = setA.size + setB.size - intersection;
    
    if (union === 0) return 0;
    
    return intersection / union;
  }

  /**
   * Static helper: quick check if transcript has new content
   */
  static async hasNewContent(
    transcriptPath: string,
    watermark: number
  ): Promise<boolean> {
    const result = await TranscriptParser.getNewEntries(transcriptPath, watermark);
    return result.entries.length > 0;
  }
}

// =============================================================================
// Export index for module
// =============================================================================

export { TranscriptParser } from './parser.js';
