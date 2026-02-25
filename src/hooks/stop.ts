/**
 * Stop Hook - Process session and extract memories
 * 
 * This is where the magic happens:
 * 1. Context sweep: Extract candidates from session events
 * 2. Selective memory: Score, classify, and store memories
 * 3. Summary generation: Create session summary
 */

import type {
  StopData,
  MemoryUnit,
  MemoryCandidate,
  PsychMemConfig,
  Session,
} from '../types/index.js';
import { DEFAULT_CONFIG } from '../types/index.js';
import { MemoryDatabase } from '../storage/database.js';
import { ContextSweep } from '../memory/context-sweep.js';
import { SelectiveMemory } from '../memory/selective-memory.js';

export interface StopResult {
  memoriesCreated: number;
  memoryIds: string[];
  summary: string;
}

export class StopHook {
  private db: MemoryDatabase;
  private config: PsychMemConfig;
  private contextSweep: ContextSweep;
  private selectiveMemory: SelectiveMemory;

  constructor(db: MemoryDatabase, config: Partial<PsychMemConfig> = {}) {
    this.db = db;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.contextSweep = new ContextSweep(this.config.sweep);
    this.selectiveMemory = new SelectiveMemory(db, this.config);
  }

  /**
   * Process session events and extract memories
   */
  async process(sessionId: string, data: StopData): Promise<StopResult> {
    // Get session for project context
    const session = this.db.getSession(sessionId);
    
    return this.processWithEvents(sessionId, data, session);
  }

  /**
   * Process using session events
   */
  private processWithEvents(sessionId: string, data: StopData, session?: Session | null): StopResult {
    // Get all session events
    const events = this.db.getSessionEvents(sessionId);
    
    // Also process conversationText if provided (direct from hook input)
    if (data.conversationText) {
      // Create a synthetic event for the conversation text
      const syntheticEvent = this.db.createEvent(
        sessionId,
        'Stop',
        data.conversationText,
        { metadata: { source: 'conversationText' } }
      );
      events.push(syntheticEvent);
    }
    
    if (events.length === 0) {
      return {
        memoriesCreated: 0,
        memoryIds: [],
        summary: 'No events to process.',
      };
    }

    // Stage 1: Context Sweep - Extract candidates
    const candidates = this.contextSweep.extractCandidates(events);
    
    if (candidates.length === 0) {
      return {
        memoriesCreated: 0,
        memoryIds: [],
        summary: this.generateSessionSummary(events, [], data),
      };
    }

    // Apply limit to candidates
    const limitedCandidates = this.applyLimit(candidates);

    // Stage 2: Selective Memory - Score and store (with sessionId and projectScope from session)
    const projectScope = session?.project?.trim() || undefined;
    const createdMemories = this.selectiveMemory.processCandidates(
      limitedCandidates,
      { sessionId, ...(projectScope ? { projectScope } : {}) }
    );
    
    // Generate summary
    const summary = this.generateSessionSummary(events, createdMemories, data);
    
    return {
      memoriesCreated: createdMemories.length,
      memoryIds: createdMemories.map(m => m.id),
      summary,
    };
  }

  /**
   * Apply maxMemoriesPerStop limit to candidates
   */
  private applyLimit(candidates: MemoryCandidate[]): MemoryCandidate[] {
    if (candidates.length <= this.config.maxMemoriesPerStop) {
      return candidates;
    }
    
    // Sort by importance and take top N
    return [...candidates]
      .sort((a, b) => b.preliminaryImportance - a.preliminaryImportance)
      .slice(0, this.config.maxMemoriesPerStop);
  }

  /**
   * Generate a summary of the session
   */
  private generateSessionSummary(
    events: any[],
    memories: MemoryUnit[],
    data: StopData
  ): string {
    const sections: string[] = [];
    
    // Session stats
    sections.push('# Session Summary');
    sections.push(`Reason: ${data.reason}`);
    sections.push(`Events processed: ${events.length}`);
    sections.push(`Memories created: ${memories.length}`);
    sections.push('');
    
    if (memories.length === 0) {
      sections.push('*No significant memories extracted from this session.*');
      return sections.join('\n');
    }
    
    // Group memories by classification
    const grouped = this.groupByClassification(memories);
    
    // Highlight important memories
    const important = memories.filter(m => m.importance >= 0.7);
    if (important.length > 0) {
      sections.push('## High-Importance Memories');
      for (const mem of important) {
        sections.push(`- [${mem.store.toUpperCase()}] ${mem.summary}`);
      }
      sections.push('');
    }
    
    // Summary by type
    sections.push('## By Type');
    for (const [classification, mems] of Object.entries(grouped)) {
      if (mems.length === 0) continue;
      const emoji = this.getClassificationEmoji(classification);
      sections.push(`- ${emoji} ${classification}: ${mems.length}`);
    }
    sections.push('');
    
    // Auto-promoted to LTM
    const ltmMemories = memories.filter(m => m.store === 'ltm');
    if (ltmMemories.length > 0) {
      sections.push('## Promoted to Long-Term Memory');
      for (const mem of ltmMemories) {
        sections.push(`- ${mem.summary.slice(0, 80)}...`);
      }
    }
    
    return sections.join('\n');
  }

  /**
   * Group memories by classification
   */
  private groupByClassification(memories: MemoryUnit[]): Record<string, MemoryUnit[]> {
    const groups: Record<string, MemoryUnit[]> = {};
    
    for (const mem of memories) {
      const classification = mem.classification;
      if (!groups[classification]) {
        groups[classification] = [];
      }
      groups[classification]!.push(mem);
    }
    
    return groups;
  }

  /**
   * Get emoji for classification
   */
  private getClassificationEmoji(classification: string): string {
    const emojis: Record<string, string> = {
      bugfix: '🔴',
      learning: '🎓',
      decision: '🤔',
      preference: '⭐',
      constraint: '🚫',
      procedural: '📋',
      semantic: '💡',
      episodic: '📅',
    };
    return emojis[classification] ?? '📝';
  }
}
