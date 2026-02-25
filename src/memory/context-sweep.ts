/**
 * Context Sweep - Stage 1 of the selective memory pipeline
 * 
 * v1.5: Now includes:
 * - Multilingual keyword patterns (15 languages)
 * - Structural/pragmatic signal detection (language-agnostic)
 * - Unified classification with confidence differentiation
 * 
 * Extracts memory candidates from raw events by detecting:
 * - Importance signals (emphasis, corrections, repetitions)
 * - Classification (bugfix, learning, decision, etc.)
 * - Preliminary relevance scoring
 * 
 * This is the CRITICAL component - without good extraction, the rest collapses.
 */

import type {
  Event,
  MemoryCandidate,
  MemoryClassification,
  ImportanceSignal,
  ImportanceSignalType,
  SweepConfig,
} from '../types/index.js';
import { DEFAULT_SWEEP_CONFIG } from '../types/index.js';
import { matchAllPatterns, classifyByPatterns } from './patterns.js';
import { StructuralAnalyzer, analyzeStructuralSignals } from './structural-analyzer.js';

// =============================================================================
// Context Sweep Implementation
// =============================================================================

export class ContextSweep {
  private config: SweepConfig;
  private structuralAnalyzer: StructuralAnalyzer;
  
  constructor(config: Partial<SweepConfig> = {}) {
    this.config = { ...DEFAULT_SWEEP_CONFIG, ...config };
    this.structuralAnalyzer = new StructuralAnalyzer();
  }
  
  /**
   * Extract memory candidates from a list of events
   */
  extractCandidates(events: Event[]): MemoryCandidate[] {
    const candidates: MemoryCandidate[] = [];
    
    // Reset structural analyzer for new extraction session
    this.structuralAnalyzer.reset();
    
    // Process user prompts
    const userPrompts = events.filter(e => e.hookType === 'UserPromptSubmit');
    for (const event of userPrompts) {
      const extracted = this.extractFromUserPrompt(event);
      if (extracted) candidates.push(extracted);
    }
    
    // Process tool outputs (especially errors/fixes)
    const toolEvents = events.filter(e => e.hookType === 'PostToolUse');
    const toolCandidates = this.extractFromToolEvents(toolEvents);
    candidates.push(...toolCandidates);
    
    // Process Stop events with conversation text (full session analysis)
    const stopEvents = events.filter(e => e.hookType === 'Stop');
    for (const event of stopEvents) {
      const extracted = this.extractFromConversationText(event);
      candidates.push(...extracted);
    }
    
    // Detect repeated concepts across events
    const repetitionCandidates = this.detectRepetitions(events);
    candidates.push(...repetitionCandidates);
    
    // Deduplicate and merge similar candidates
    const deduped = this.deduplicateCandidates(candidates);

    // Bug C fix: discard fragment/truncated summaries shorter than 20 meaningful chars
    // Strip leading emoji/whitespace before measuring
    return deduped.filter(c => {
      const stripped = c.summary.replace(/^[\p{Emoji}\s]+/u, '').trim();
      return stripped.length >= 20;
    });
  }

  /**
   * Content quality gate — rejects chunks that are primarily code, JSON, file paths,
   * line-number-prefixed tool output, or truncated fragments.
   *
   * Returns true if the content is acceptable prose-quality text worth storing as memory.
   */
  private isContentQualityAcceptable(text: string): boolean {
    const trimmed = text.trim();
    if (trimmed.length < 20) return false;

    // Reject if ends with a truncation marker (raw tool output that leaked through)
    if (/\.\.\.\[truncated\]$|\.\.\.$/.test(trimmed)) return false;

    // Reject if the majority of lines start with line-number prefixes (Read tool output)
    // Pattern: "123: " or "  123: " — characteristic of our own Read tool output
    const lines = trimmed.split('\n');
    const lineNumberedLines = lines.filter(l => /^\s*\d{1,5}:\s/.test(l));
    if (lines.length >= 3 && lineNumberedLines.length / lines.length > 0.5) return false;

    // Count characters in code fence blocks
    const codeFenceContent = trimmed.match(/```[\s\S]*?```/g)?.join('') ?? '';
    const inlineCodeContent = trimmed.match(/`[^`\n]+`/g)?.join('') ?? '';
    const codeChars = codeFenceContent.length + inlineCodeContent.length;
    const codeRatio = codeChars / Math.max(1, trimmed.length);

    // Reject if >60% of content is inside code fences/inline code
    if (codeRatio > 0.6) return false;

    // Count structural/special characters outside code blocks
    const textWithoutCode = trimmed
      .replace(/```[\s\S]*?```/g, '')
      .replace(/`[^`\n]+`/g, '');
    const specialChars = (textWithoutCode.match(/[{}[\]()=><;|&\\]/g) ?? []).length;
    const alphanumChars = (textWithoutCode.match(/[a-zA-Z0-9]/g) ?? []).length;
    const specialRatio = specialChars / Math.max(1, alphanumChars);

    // Reject if special character density exceeds 30% of alphanumeric chars
    if (specialRatio > 0.3) return false;

    // Reject if it's primarily a file path list (no sentence structure)
    const pathOnlyLines = lines.filter(l => /^\s*(?:[A-Za-z]:\\|\/[\w.-]|\.\/)[\w./-]+/.test(l.trim()));
    if (lines.length >= 2 && pathOnlyLines.length / lines.length > 0.7) return false;

    return true;
  }


  private extractFromConversationText(event: Event): MemoryCandidate[] {
    const content = event.content;
    const candidates: MemoryCandidate[] = [];
    
    // Split into semantic chunks (paragraphs or sentences)
    const chunks = this.splitIntoChunks(content);
    
    // Track if previous chunk had tool errors (for meta signal detection)
    let prevChunkHadToolError = false;
    
    for (const chunk of chunks) {
      // Skip tool output and assistant-generated chunks — only user text
      // contains genuine preferences, decisions, constraints, etc.
      const chunkRole = this.detectChunkRole(chunk);
      if (chunkRole === 'tool') continue;
      if (chunkRole === 'assistant') {
        // Track tool errors from assistant tool-use markers but don't extract
        prevChunkHadToolError = this.chunkHasToolError(chunk);
        continue;
      }

      const signals: ImportanceSignal[] = [];
      let hasRegexSignal = false;
      let hasStructuralSignal = false;
      
      // Layer 1: Multilingual regex patterns
      if (this.config.enableRegexPatterns) {
        const regexSignals = matchAllPatterns(chunk);
        if (regexSignals.length > 0) {
          hasRegexSignal = true;
          signals.push(...regexSignals);
        }
      }
      
      // Layer 2: Structural/pragmatic signals
      if (this.config.enableStructuralAnalysis) {
        // Determine role from chunk prefix
        const role = this.detectChunkRole(chunk);
        
        // Analyze with conversation context
        const structuralSignals = this.structuralAnalyzer.analyze(
          chunk,
          role,
          prevChunkHadToolError
        );
        
        // Apply structural weight multiplier
        for (const signal of structuralSignals) {
          signal.weight *= this.config.structuralWeight;
        }
        
        if (structuralSignals.length > 0) {
          hasStructuralSignal = true;
          signals.push(...structuralSignals);
        }
        
        // Track tool errors for next chunk
        prevChunkHadToolError = this.chunkHasToolError(chunk);
      }
      
      // Only create candidate if we found importance signals
      if (signals.length === 0) continue;
      
      // Filter out low-weight signals
      const significantSignals = signals.filter(s => s.weight >= this.config.signalThreshold);
      if (significantSignals.length === 0) continue;

      // Content quality gate — reject code-heavy, path-only, truncated chunks
      if (!this.isContentQualityAcceptable(chunk)) continue;
      
      const classification = this.classifyContentMultilingual(chunk, significantSignals);
      const summary = this.generateSummary(chunk, classification, significantSignals);
      
      // Confidence: 0.75 for regex matches, 0.5 for structural-only
      const confidence = hasRegexSignal 
        ? this.config.regexConfidence 
        : this.config.structuralConfidence;
      
      candidates.push({
        summary,
        classification,
        sourceEventIds: [event.id],
        importanceSignals: significantSignals,
        preliminaryImportance: this.calculatePreliminaryImportance(significantSignals),
        extractionMethod: this.getExtractionMethod(hasRegexSignal, hasStructuralSignal),
        confidence,
      });
    }
    
    return candidates;
  }
  
  /**
   * Detect the role (user/assistant/tool) from chunk prefix
   */
  private detectChunkRole(chunk: string): 'user' | 'assistant' | 'tool' | undefined {
    const trimmed = chunk.trim();
    if (trimmed.startsWith('Human:') || trimmed.startsWith('User:')) return 'user';
    if (trimmed.startsWith('Assistant:')) return 'assistant';
    if (trimmed.startsWith('Tool Result:') || trimmed.startsWith('Tool Error:')) return 'tool';
    return undefined;
  }
  
  /**
   * Check if chunk contains tool error indicators
   */
  private chunkHasToolError(chunk: string): boolean {
    return /Tool Error:|error|exception|failed|Error:/i.test(chunk);
  }
  
  /**
   * Get extraction method description
   */
  private getExtractionMethod(hasRegex: boolean, hasStructural: boolean): string {
    if (hasRegex && hasStructural) return 'multilingual_and_structural';
    if (hasRegex) return 'multilingual_patterns';
    if (hasStructural) return 'structural_analysis';
    return 'conversation_analysis';
  }
  
  /**
   * Split content into semantic chunks for analysis.
   * 
   * Strategies (tried in order):
   * 1. Double-newline paragraphs (standard prose)
   * 2. Conversation turns (Human:/Assistant: prefixed lines from extractConversationText)
   * 3. Sentences
   * 4. Whole content as single chunk
   */
  private splitIntoChunks(content: string): string[] {
    // If the content has role prefixes (Human:/Assistant:), skip straight to
    // turn-based splitting. Paragraph splitting would strip those prefixes,
    // causing detectChunkRole() to return undefined and letting assistant
    // reasoning slip through the extraction filter as if it were user text.
    const hasTurnPattern = /^(Human|Assistant|Tool Result|Tool Error):/m.test(content);

    // 1. Double-newline paragraphs — only when there are no role prefixes
    if (!hasTurnPattern) {
      const paragraphs = content.split(/\n\s*\n/).filter(p => p.trim().length > 20);
      if (paragraphs.length > 1) {
        return paragraphs;
      }
    }

    // 2. Conversation turns — split on Human:/Assistant: boundaries
    //    Groups consecutive lines belonging to the same speaker
    if (hasTurnPattern) {
      const turns: string[] = [];
      let currentTurn = '';
      
      for (const line of content.split('\n')) {
        if (/^(Human|Assistant|Tool Result|Tool Error):/.test(line) && currentTurn.trim()) {
          turns.push(currentTurn.trim());
          currentTurn = line;
        } else {
          currentTurn += (currentTurn ? '\n' : '') + line;
        }
      }
      if (currentTurn.trim()) {
        turns.push(currentTurn.trim());
      }
      
      // Group Human+Assistant turns together as exchange pairs
      const exchanges: string[] = [];
      for (let i = 0; i < turns.length; i += 2) {
        const exchange = turns.slice(i, i + 2).join('\n');
        if (exchange.length > 20) {
          exchanges.push(exchange);
        }
      }
      
      if (exchanges.length > 0) {
        return exchanges;
      }
    }
    
    // 3. Sentences
    const sentences = content.split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 10);
    if (sentences.length > 1) {
      return sentences;
    }
    
    // 4. Whole content
    return content.length > 20 ? [content] : [];
  }

  /**
   * Extract candidate from a user prompt
   * v1.5: Now uses multilingual patterns + structural signals
   */
  private extractFromUserPrompt(event: Event): MemoryCandidate | null {
    const content = event.content;
    const signals: ImportanceSignal[] = [];
    let hasRegexSignal = false;
    let hasStructuralSignal = false;
    
    // Layer 1: Multilingual patterns
    if (this.config.enableRegexPatterns) {
      const regexSignals = matchAllPatterns(content);
      if (regexSignals.length > 0) {
        hasRegexSignal = true;
        signals.push(...regexSignals);
      }
    }
    
    // Layer 2: Structural signals (standalone, no context)
    if (this.config.enableStructuralAnalysis) {
      const structuralSignals = analyzeStructuralSignals(content);
      for (const signal of structuralSignals) {
        signal.weight *= this.config.structuralWeight;
      }
      if (structuralSignals.length > 0) {
        hasStructuralSignal = true;
        signals.push(...structuralSignals);
      }
    }
    
    // Only create candidate if we found importance signals
    if (signals.length === 0) return null;
    
    // Filter out low-weight signals
    const significantSignals = signals.filter(s => s.weight >= this.config.signalThreshold);
    if (significantSignals.length === 0) return null;

    // Content quality gate — reject code-heavy, path-only, truncated content
    if (!this.isContentQualityAcceptable(content)) return null;
    
    const classification = this.classifyContentMultilingual(content, significantSignals);
    const summary = this.generateSummary(content, classification, significantSignals);
    
    const confidence = hasRegexSignal 
      ? this.config.regexConfidence 
      : this.config.structuralConfidence;
    
    return {
      summary,
      classification,
      sourceEventIds: [event.id],
      importanceSignals: significantSignals,
      preliminaryImportance: this.calculatePreliminaryImportance(significantSignals),
      extractionMethod: this.getExtractionMethod(hasRegexSignal, hasStructuralSignal),
      confidence,
    };
  }

  /**
   * Extract candidates from tool events (bugs + fixes only).
   *
   * Only creates a memory when BOTH an error signal AND a resolution signal
   * are present in the same event.  Plain file reads, grep output, diffs,
   * and successful-but-unremarkable tool calls are deliberately ignored.
   */
  private extractFromToolEvents(events: Event[]): MemoryCandidate[] {
    const candidates: MemoryCandidate[] = [];

    // Patterns that indicate an actual error/problem occurred
    const ERROR_PATTERN = /\b(error|exception|failed|failure|cannot|can't|undefined|null pointer|stack trace|traceback|syntax error|type error|reference error|uncaught)\b/i;

    // Patterns that indicate the problem was understood or resolved
    const RESOLUTION_PATTERN = /\b(fixed|resolved|solved|corrected|updated|changed|now works|working|success|done|applied|patched)\b/i;

    for (const event of events) {
      const toolOutput = event.toolOutput ?? '';
      const toolInput  = event.toolInput  ?? '';

      // Require BOTH an error signal AND a resolution/fix signal.
      // Without both, the event is not worth storing as a memory.
      const hasError      = ERROR_PATTERN.test(toolOutput) || ERROR_PATTERN.test(toolInput);
      const hasResolution = RESOLUTION_PATTERN.test(toolOutput) || RESOLUTION_PATTERN.test(toolInput);

      if (!hasError || !hasResolution) continue;

      // Build a minimal, meaningful signal set — only bug_fix/tool_failure types
      const signals: ImportanceSignal[] = [
        {
          type: 'bug_fix' as ImportanceSignalType,
          source: event.toolName ?? 'tool',
          weight: 0.75,
        },
      ];

      candidates.push({
        summary: this.generateToolSummary(event, 'bugfix'),
        classification: 'bugfix',
        sourceEventIds: [event.id],
        importanceSignals: signals,
        preliminaryImportance: 0.75,
        extractionMethod: 'tool_event_analysis',
        confidence: 0.65,
      });
    }

    return candidates;
  }

  /**
   * Detect repeated concepts/requests across events
   */
  private detectRepetitions(events: Event[]): MemoryCandidate[] {
    const candidates: MemoryCandidate[] = [];
    const conceptCounts = new Map<string, { count: number; eventIds: string[]; content: string }>();
    
    // Extract key concepts from each event
    for (const event of events) {
      const concepts = this.extractKeyConcepts(event.content);
      for (const concept of concepts) {
        const existing = conceptCounts.get(concept);
        if (existing) {
          existing.count++;
          existing.eventIds.push(event.id);
        } else {
          conceptCounts.set(concept, {
            count: 1,
            eventIds: [event.id],
            content: event.content,
          });
        }
      }
    }
    
    // Create candidates for repeated concepts (3+ mentions)
    for (const [concept, data] of conceptCounts.entries()) {
      if (data.count >= 3) {
        candidates.push({
          summary: `Repeated concept: ${concept} (mentioned ${data.count} times)`,
          classification: 'semantic',
          sourceEventIds: data.eventIds,
          importanceSignals: [{
            type: 'repeated_request',
            source: concept,
            weight: Math.min(0.9, 0.5 + data.count * 0.1),
          }],
          preliminaryImportance: Math.min(0.9, 0.5 + data.count * 0.1),
          extractionMethod: 'repetition_detection',
          confidence: 0.5,
        });
      }
    }
    
    return candidates;
  }

  /**
   * Classify content into a memory classification
   * v1.5: Uses multilingual patterns first, then structural heuristics
   */
  private classifyContentMultilingual(
    content: string,
    signals: ImportanceSignal[]
  ): MemoryClassification {
    // Try multilingual pattern-based classification first
    const patternClassification = classifyByPatterns(content);
    if (patternClassification) {
      return patternClassification as MemoryClassification;
    }
    
    // Fall back to signal type-based classification
    const signalTypes = new Set(signals.map(s => s.type));
    
    if (signalTypes.has('bug_fix') || signalTypes.has('tool_failure')) {
      return 'bugfix';
    }
    if (signalTypes.has('learning')) {
      return 'learning';
    }
    if (signalTypes.has('constraint')) {
      return 'constraint';
    }
    if (signalTypes.has('decision')) {
      return 'decision';
    }
    if (signalTypes.has('preference')) {
      return 'preference';
    }
    if (signalTypes.has('correction') || signalTypes.has('correction_pattern')) {
      return 'learning'; // Corrections often contain learnings
    }
    if (signalTypes.has('elaboration') || signalTypes.has('structural_enumeration')) {
      return 'procedural'; // Detailed explanations are often procedural
    }
    
    // Default to semantic (general knowledge)
    return 'semantic';
  }

  /**
   * Generate a concise summary for a memory candidate
   * v1.5: Considers structural signals in summary selection
   */
  private generateSummary(
    content: string,
    classification: MemoryClassification,
    signals: ImportanceSignal[]
  ): string {
    // Extract the most relevant sentence or phrase
    const sentences = content.split(/[.!?]+/).filter(s => s.trim().length > 10);
    
    if (sentences.length === 0) {
      return this.formatSummary(content.slice(0, 200), classification);
    }
    
    // Find the sentence with the most importance signals
    let bestSentence = sentences[0];
    let bestScore = 0;
    
    for (const sentence of sentences) {
      let score = 0;
      
      // Check multilingual patterns in sentence
      const sentenceSignals = matchAllPatterns(sentence);
      for (const signal of sentenceSignals) {
        score += signal.weight;
      }
      
      // Check structural signals
      const structuralSignals = analyzeStructuralSignals(sentence);
      for (const signal of structuralSignals) {
        score += signal.weight * 0.5; // Lower weight for structural in summary selection
      }
      
      if (score > bestScore) {
        bestScore = score;
        bestSentence = sentence;
      }
    }
    
    return this.formatSummary(bestSentence ?? sentences[0] ?? content.slice(0, 200), classification);
  }
  
  /**
   * Format summary with classification prefix
   */
  private formatSummary(text: string, classification: MemoryClassification): string {
    const emoji = this.getClassificationEmoji(classification);
    return `${emoji} ${text.trim()}`.slice(0, 300);
  }

  /**
   * Generate summary for tool events.
   *
   * Derives a human-readable description from the tool name and the
   * error/resolution signals — does NOT dump raw tool output into the
   * summary, which would produce noise like "🔴 read: <path>C:\...".
   */
  private generateToolSummary(event: Event, classification: MemoryClassification): string {
    const emoji = this.getClassificationEmoji(classification);
    const toolName = event.toolName ?? 'tool';

    // Try to extract just the error message line (first line matching error keywords)
    const errorLine = (event.toolOutput ?? '')
      .split('\n')
      .map(l => l.trim())
      .find(l => /\b(error|exception|failed|failure|cannot|can't)\b/i.test(l));

    if (errorLine) {
      // Truncate and clean — no raw file paths if we can avoid it
      const cleaned = errorLine
        .replace(/[A-Za-z]:\\[^\s:,]+/g, '<path>') // collapse Windows absolute paths
        .replace(/\/[^\s:,]{10,}/g, '<path>')       // collapse Unix absolute paths
        .slice(0, 200);
      return `${emoji} ${toolName} error fixed: ${cleaned}`;
    }

    // Fallback: generic description without raw content
    return `${emoji} ${toolName} error encountered and resolved`;
  }

  /**
   * Get emoji for classification
   */
  private getClassificationEmoji(classification: MemoryClassification): string {
    const emojis: Record<MemoryClassification, string> = {
      episodic: '📅',
      semantic: '💡',
      procedural: '📋',
      bugfix: '🔴',
      learning: '🎓',
      preference: '⭐',
      decision: '🤔',
      constraint: '🚫',
    };
    return emojis[classification] ?? '📝';
  }

  /**
   * Calculate preliminary importance from signals
   */
  private calculatePreliminaryImportance(signals: ImportanceSignal[]): number {
    if (signals.length === 0) return 0.3;
    
    // Combine signals with diminishing returns
    let importance = 0;
    const sortedSignals = [...signals].sort((a, b) => b.weight - a.weight);
    
    for (let i = 0; i < sortedSignals.length; i++) {
      const signal = sortedSignals[i];
      if (signal) {
        importance += signal.weight * Math.pow(0.7, i);
      }
    }
    
    return Math.min(1, importance);
  }

  /**
   * Extract key concepts from content (simple keyword extraction)
   */
  private extractKeyConcepts(content: string): string[] {
    // Remove common words and extract significant terms
    const stopWords = new Set([
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
      'should', 'may', 'might', 'can', 'to', 'of', 'in', 'for', 'on', 'with',
      'at', 'by', 'from', 'as', 'into', 'through', 'during', 'before', 'after',
      'above', 'below', 'between', 'under', 'again', 'further', 'then', 'once',
      'here', 'there', 'when', 'where', 'why', 'how', 'all', 'each', 'few',
      'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only',
      'own', 'same', 'so', 'than', 'too', 'very', 'just', 'and', 'but', 'if',
      'or', 'because', 'until', 'while', 'this', 'that', 'these', 'those',
      'i', 'me', 'my', 'myself', 'we', 'our', 'ours', 'ourselves', 'you',
      'your', 'yours', 'yourself', 'yourselves', 'he', 'him', 'his', 'himself',
      'she', 'her', 'hers', 'herself', 'it', 'its', 'itself', 'they', 'them',
      'their', 'theirs', 'themselves', 'what', 'which', 'who', 'whom',
    ]);
    
    const words = content
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3 && !stopWords.has(w));
    
    // Return unique words
    return [...new Set(words)];
  }

  /**
   * Deduplicate and merge similar candidates
   */
  private deduplicateCandidates(candidates: MemoryCandidate[]): MemoryCandidate[] {
    if (candidates.length <= 1) return candidates;
    
    const merged: MemoryCandidate[] = [];
    const used = new Set<number>();
    
    for (let i = 0; i < candidates.length; i++) {
      if (used.has(i)) continue;
      
      const baseCandidate = candidates[i];
      if (!baseCandidate) continue;
      
      let current: MemoryCandidate = baseCandidate;
      
      for (let j = i + 1; j < candidates.length; j++) {
        if (used.has(j)) continue;
        
        const other = candidates[j];
        if (!other) continue;
        
        const similarity = this.calculateSimilarity(
          current.summary,
          other.summary
        );
        
        if (similarity > 0.7) {
          // Merge candidates
          current = {
            summary: current.summary,
            classification: current.classification,
            extractionMethod: current.extractionMethod,
            sourceEventIds: [...new Set([...current.sourceEventIds, ...other.sourceEventIds])],
            importanceSignals: [...current.importanceSignals, ...other.importanceSignals],
            preliminaryImportance: Math.max(current.preliminaryImportance, other.preliminaryImportance),
            confidence: Math.max(current.confidence, other.confidence), // Take higher confidence
          };
          used.add(j);
        }
      }
      
      merged.push(current);
      used.add(i);
    }
    
    return merged;
  }

  /**
   * Simple similarity calculation (Jaccard index on words)
   */
  private calculateSimilarity(a: string, b: string): number {
    const wordsA = new Set(a.toLowerCase().split(/\s+/));
    const wordsB = new Set(b.toLowerCase().split(/\s+/));
    
    const intersection = new Set([...wordsA].filter(x => wordsB.has(x)));
    const union = new Set([...wordsA, ...wordsB]);
    
    return union.size === 0 ? 0 : intersection.size / union.size;
  }
}
