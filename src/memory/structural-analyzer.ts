/**
 * Structural Signal Analyzer
 * 
 * Language-agnostic importance detection based on:
 * - Typography: ALL CAPS, exclamation density, bold/emphasis markdown, quotes
 * - Conversation flow: correction patterns, repetition, elaboration
 * - Discourse markers: arrows, contrast, ordered lists
 * - Meta signals: proximity to tool errors, file paths, stack traces
 */

import type { ImportanceSignal, ImportanceSignalType } from '../types/index.js';

// =============================================================================
// Types
// =============================================================================

export interface ChunkContext {
  /** The text chunk being analyzed */
  text: string;
  /** Index of this chunk in the conversation */
  index: number;
  /** Role if known (user/assistant) */
  role?: 'user' | 'assistant' | 'tool';
  /** Whether this chunk follows a tool error */
  followsToolError?: boolean;
}

export interface ConversationContext {
  /** All chunks in the conversation */
  chunks: ChunkContext[];
  /** Median chunk length (computed once) */
  medianLength?: number;
}

// =============================================================================
// Typography Analysis
// =============================================================================

/**
 * Analyze typography-based importance signals.
 * These are language-agnostic and work on text structure.
 */
export function analyzeTypography(text: string): ImportanceSignal[] {
  const signals: ImportanceSignal[] = [];
  
  // ALL CAPS detection - ratio of uppercase letters
  const capsRatio = detectCapsRatio(text);
  if (capsRatio > 0.3 && text.length > 10) {
    signals.push({
      type: 'typography_emphasis',
      source: 'ALL_CAPS',
      weight: Math.min(0.7, 0.4 + capsRatio * 0.4), // 0.4-0.7 based on ratio
    });
  }
  
  // Exclamation density
  const exclamationDensity = (text.match(/!/g) || []).length / Math.max(1, text.length / 50);
  if (exclamationDensity > 0.5) {
    signals.push({
      type: 'typography_emphasis',
      source: 'exclamation',
      weight: Math.min(0.5, 0.3 + exclamationDensity * 0.2),
    });
  }
  
  // Bold/emphasis markdown
  const boldMatches = text.match(/\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_/g);
  if (boldMatches && boldMatches.length > 0) {
    signals.push({
      type: 'typography_emphasis',
      source: 'markdown_emphasis',
      weight: 0.6,
    });
  }
  
  // Quoted text (important references)
  const quoteMatches = text.match(/"[^"]{5,}"|'[^']{5,}'|「[^」]+」|「[^」]+」|«[^»]+»/g);
  if (quoteMatches && quoteMatches.length > 0) {
    signals.push({
      type: 'quoted_text',
      source: quoteMatches[0].slice(0, 30),
      weight: 0.5,
    });
  }
  
  // Code blocks (context-dependent) — lowered weight, code is ubiquitous in programming
  const codeBlockMatches = text.match(/```[\s\S]*?```|`[^`]+`/g);
  if (codeBlockMatches && codeBlockMatches.length > 0) {
    signals.push({
      type: 'code_block',
      source: 'code',
      weight: 0.25, // Lowered from 0.4 — code alone is not memory-worthy
    });
  }
  
  return signals;
}

/**
 * Calculate the ratio of uppercase letters in text.
 * Ignores non-alphabetic characters.
 */
function detectCapsRatio(text: string): number {
  const letters = text.match(/[a-zA-Z]/g);
  if (!letters || letters.length < 5) return 0;
  
  const uppercase = letters.filter(c => c === c.toUpperCase()).length;
  return uppercase / letters.length;
}

// =============================================================================
// Conversation Flow Analysis
// =============================================================================

/**
 * Analyze conversation flow patterns across chunks.
 * Detects corrections, repetitions, and elaborations.
 */
export function analyzeConversationFlow(
  chunk: ChunkContext,
  context: ConversationContext
): ImportanceSignal[] {
  const signals: ImportanceSignal[] = [];
  
  // Need at least 2 chunks for flow analysis
  if (context.chunks.length < 2 || chunk.index === 0) {
    return signals;
  }
  
  const prevChunk = context.chunks[chunk.index - 1];
  
  // Correction pattern: short reply after long (user correcting)
  if (prevChunk && chunk.role === 'user' && prevChunk.role === 'assistant') {
    const ratio = chunk.text.length / Math.max(1, prevChunk.text.length);
    if (ratio < 0.2 && chunk.text.length < 100) {
      // Short user reply after long assistant response = likely correction
      signals.push({
        type: 'correction_pattern',
        source: 'short_after_long',
        weight: 0.7,
      });
    }
  }
  
  // Repetition pattern: user repeating similar content (trigram overlap)
  if (chunk.role === 'user') {
    const userChunks = context.chunks.filter(c => c.role === 'user' && c.index < chunk.index);
    for (const prevUserChunk of userChunks.slice(-3)) { // Check last 3 user messages
      const overlap = calculateTrigramOverlap(chunk.text, prevUserChunk.text);
      if (overlap > 0.4) {
        signals.push({
          type: 'repetition_pattern',
          source: 'trigram_overlap',
          weight: Math.min(0.8, 0.5 + overlap * 0.4),
        });
        break; // Only report once
      }
    }
  }
  
  // Elaboration pattern: reply significantly longer than median
  const medianLength = context.medianLength || calculateMedianLength(context.chunks);
  if (chunk.text.length > medianLength * 2.5 && chunk.text.length > 200) {
    signals.push({
      type: 'elaboration',
      source: 'long_response',
      weight: 0.6,
    });
  }
  
  return signals;
}

/**
 * Calculate trigram overlap between two texts.
 * Returns a value between 0 and 1.
 */
function calculateTrigramOverlap(text1: string, text2: string): number {
  const trigrams1 = extractTrigrams(text1.toLowerCase());
  const trigrams2 = extractTrigrams(text2.toLowerCase());
  
  if (trigrams1.size === 0 || trigrams2.size === 0) return 0;
  
  let overlap = 0;
  for (const trigram of trigrams1) {
    if (trigrams2.has(trigram)) overlap++;
  }
  
  return overlap / Math.min(trigrams1.size, trigrams2.size);
}

/**
 * Extract word trigrams from text.
 */
function extractTrigrams(text: string): Set<string> {
  const words = text.split(/\s+/).filter(w => w.length > 2);
  const trigrams = new Set<string>();
  
  for (let i = 0; i < words.length - 2; i++) {
    trigrams.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  }
  
  return trigrams;
}

/**
 * Calculate median length of chunks.
 */
function calculateMedianLength(chunks: ChunkContext[]): number {
  if (chunks.length === 0) return 100;
  
  const lengths = chunks.map(c => c.text.length).sort((a, b) => a - b);
  const mid = Math.floor(lengths.length / 2);
  
  if (lengths.length % 2 === 0) {
    const left = lengths[mid - 1];
    const right = lengths[mid];
    return (left !== undefined && right !== undefined) ? (left + right) / 2 : 100;
  }
  
  return lengths[mid] ?? 100;
}

// =============================================================================
// Discourse Marker Analysis
// =============================================================================

/**
 * Analyze discourse markers that indicate structured/important content.
 */
export function analyzeDiscourseMarkers(text: string): ImportanceSignal[] {
  const signals: ImportanceSignal[] = [];
  
  // Arrow markers (→, =>, ->, →)
  if (/[→⇒]|=>|->/.test(text)) {
    signals.push({
      type: 'structural_enumeration',
      source: 'arrow',
      weight: 0.5,
    });
  }
  
  // Contrast markers (—, --, vs, versus)
  if (/\s—\s|\s--\s|\bvs\.?\b|\bversus\b/i.test(text)) {
    signals.push({
      type: 'structural_enumeration',
      source: 'contrast',
      weight: 0.5,
    });
  }
  
  // Ordered lists (1. 2. 3. or a) b) c) or bullet points)
  const listMatches = text.match(/^\s*(?:\d+[.)]\s|[a-z][.)]\s|[-*•]\s)/gm);
  if (listMatches && listMatches.length >= 2) {
    signals.push({
      type: 'structural_enumeration',
      source: 'ordered_list',
      weight: 0.5 + Math.min(0.3, listMatches.length * 0.05), // Up to 0.8 for longer lists
    });
  }
  
  // Colon-based definitions (term: definition) — slightly reduced
  if (/^[A-Z][^:]{2,30}:\s/m.test(text)) {
    signals.push({
      type: 'structural_enumeration',
      source: 'definition',
      weight: 0.3, // Lowered from 0.4
    });
  }
  
  return signals;
}

// =============================================================================
// Meta Signal Analysis
// =============================================================================

/**
 * Analyze meta-level signals like proximity to errors, file paths, etc.
 */
export function analyzeMetaSignals(chunk: ChunkContext, context: ConversationContext): ImportanceSignal[] {
  const signals: ImportanceSignal[] = [];
  const text = chunk.text;
  
  // Near tool error output
  if (chunk.followsToolError) {
    signals.push({
      type: 'meta_reference',
      source: 'follows_error',
      weight: 0.8,
    });
  }
  
  // Check if previous chunk was a tool error
  if (chunk.index > 0) {
    const prevChunk = context.chunks[chunk.index - 1];
    if (prevChunk && prevChunk.role === 'tool' && 
        (prevChunk.text.toLowerCase().includes('error') || 
         prevChunk.text.toLowerCase().includes('failed') ||
         prevChunk.text.toLowerCase().includes('exception'))) {
      signals.push({
        type: 'meta_reference',
        source: 'after_tool_error',
        weight: 0.8,
      });
    }
  }
  
  // File paths (Unix and Windows) — lowered weight, file paths alone are not memory-worthy
  const filePathPattern = /(?:\/[\w.-]+)+\.\w+|[A-Z]:\\(?:[\w.-]+\\)*[\w.-]+\.\w+/g;
  if (filePathPattern.test(text)) {
    signals.push({
      type: 'meta_reference',
      source: 'file_path',
      weight: 0.25, // Lowered from 0.4
    });
  }
  
  // Stack traces
  const stackTraceIndicators = [
    /at\s+\w+\s+\([^)]+:\d+:\d+\)/,  // JavaScript
    /File "[^"]+", line \d+/,         // Python
    /^\s+at\s+[\w.$]+\([^)]+\)/m,     // Java
    /Traceback \(most recent call last\)/,
    /Error:.*\n\s+at\s/,
  ];
  
  for (const pattern of stackTraceIndicators) {
    if (pattern.test(text)) {
      signals.push({
        type: 'meta_reference',
        source: 'stack_trace',
        weight: 0.7,
      });
      break;
    }
  }
  
  // URL references — lowered weight, URLs alone are not memory-worthy
  if (/https?:\/\/[^\s]+/.test(text)) {
    signals.push({
      type: 'meta_reference',
      source: 'url',
      weight: 0.2, // Lowered from 0.3
    });
  }
  
  return signals;
}

// =============================================================================
// Main Analyzer Class
// =============================================================================

export class StructuralAnalyzer {
  private conversationContext: ConversationContext;
  
  constructor() {
    this.conversationContext = { chunks: [] };
  }
  
  /**
   * Reset the analyzer for a new conversation.
   */
  reset(): void {
    this.conversationContext = { chunks: [] };
  }
  
  /**
   * Add a chunk to the conversation context.
   */
  addChunk(text: string, role?: 'user' | 'assistant' | 'tool', followsToolError?: boolean): ChunkContext {
    const chunk: ChunkContext = {
      text,
      index: this.conversationContext.chunks.length,
      ...(role !== undefined && { role }),
      ...(followsToolError !== undefined && { followsToolError }),
    };
    this.conversationContext.chunks.push(chunk);
    
    // Recompute median length
    this.conversationContext.medianLength = calculateMedianLength(this.conversationContext.chunks);
    
    return chunk;
  }
  
  /**
   * Analyze a chunk for all structural signals.
   * Call addChunk first, then analyzeChunk with the returned context.
   */
  analyzeChunk(chunk: ChunkContext): ImportanceSignal[] {
    const signals: ImportanceSignal[] = [];
    
    // Typography analysis (always runs)
    signals.push(...analyzeTypography(chunk.text));
    
    // Conversation flow analysis (needs context)
    signals.push(...analyzeConversationFlow(chunk, this.conversationContext));
    
    // Discourse marker analysis
    signals.push(...analyzeDiscourseMarkers(chunk.text));
    
    // Meta signal analysis
    signals.push(...analyzeMetaSignals(chunk, this.conversationContext));
    
    return signals;
  }
  
  /**
   * Convenience method: add chunk and analyze in one call.
   */
  analyze(text: string, role?: 'user' | 'assistant' | 'tool', followsToolError?: boolean): ImportanceSignal[] {
    const chunk = this.addChunk(text, role, followsToolError);
    return this.analyzeChunk(chunk);
  }
  
  /**
   * Analyze text without adding to conversation context.
   * Useful for one-off analysis.
   */
  analyzeStandalone(text: string): ImportanceSignal[] {
    const signals: ImportanceSignal[] = [];
    
    signals.push(...analyzeTypography(text));
    signals.push(...analyzeDiscourseMarkers(text));
    
    // For standalone, create a minimal context
    const chunk: ChunkContext = { text, index: 0 };
    const minimalContext: ConversationContext = { chunks: [chunk] };
    signals.push(...analyzeMetaSignals(chunk, minimalContext));
    
    return signals;
  }
}

// =============================================================================
// Utility Exports
// =============================================================================

/**
 * Quick utility to analyze text for structural signals without managing state.
 */
export function analyzeStructuralSignals(text: string): ImportanceSignal[] {
  const analyzer = new StructuralAnalyzer();
  return analyzer.analyzeStandalone(text);
}
