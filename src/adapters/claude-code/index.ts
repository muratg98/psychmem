/**
 * Claude Code Adapter for PsychMem
 * 
 * Integration with Claude Code's auto-memory system:
 * - Claude Code reads from ~/.claude/projects/<project>/memory/MEMORY.md
 * - First 200 lines are loaded at each session start
 * - Topic files (*.md) are loaded on demand via @mention
 * 
 * This adapter:
 * 1. Writes memories to the auto-memory directory
 * 2. Organizes memories by topic for efficient loading
 * 3. Keeps MEMORY.md under 200 lines for full loading
 * 4. Uses the existing hook system via CLI for extraction
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join, basename } from 'path';
import type { PsychMemAdapter } from '../types.js';
import type { PsychMemConfig, MemoryUnit, MemoryClassification } from '../../types/index.js';
import { DEFAULT_CONFIG, USER_LEVEL_CLASSIFICATIONS, getScopeForClassification } from '../../types/index.js';
import { PsychMem, createPsychMem } from '../../core.js';
import { MemoryDatabase, createMemoryDatabase } from '../../storage/database.js';
import { MemoryRetrieval } from '../../retrieval/index.js';

// =============================================================================
// Constants
// =============================================================================

/** Claude Code's auto-memory base directory */
const CLAUDE_MEMORY_BASE = join(homedir(), '.claude', 'projects');

/** Maximum lines for MEMORY.md (Claude loads first 200) */
const MAX_MEMORY_LINES = 195; // Leave some buffer

/** Topic file names mapping classifications to files */
const TOPIC_FILES: Record<string, MemoryClassification[]> = {
  'constraints': ['constraint', 'preference'],
  'learnings': ['learning', 'procedural'],
  'decisions': ['decision'],
  'bugfixes': ['bugfix'],
  'context': ['episodic', 'semantic'],
};

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Convert a project path to a Claude Code-compatible project ID.
 *
 * Claude Code uses the full absolute path with every non-alphanumeric run
 * replaced by a single dash, matching the actual directory names observed
 * on disk (e.g. C:\Users\foo\bar → C--Users-foo-bar on Windows,
 * /Users/foo/bar → -Users-foo-bar on Unix).
 */
function projectPathToId(projectPath: string): string {
  // Normalize separators then replace every non-alphanumeric character
  // (colon, slash, backslash, dot, space, etc.) with a dash, collapsing
  // consecutive runs.  Do NOT strip the drive letter – Claude keeps it.
  return projectPath
    .replace(/\\/g, '/')            // Normalize Windows separators
    .replace(/[^a-zA-Z0-9]+/g, '-') // Replace every non-alphanumeric run with -
    .replace(/^-/, '')              // Remove any leading dash
    .replace(/-$/, '');             // Remove any trailing dash
}

/**
 * Get the memory directory for a project
 */
function getMemoryDir(projectPath: string): string {
  const projectId = projectPathToId(projectPath);
  return join(CLAUDE_MEMORY_BASE, projectId, 'memory');
}

/**
 * Ensure the memory directory exists
 */
function ensureMemoryDir(projectPath: string): string {
  const memoryDir = getMemoryDir(projectPath);
  if (!existsSync(memoryDir)) {
    mkdirSync(memoryDir, { recursive: true });
  }
  return memoryDir;
}

/**
 * Format a single memory for file output
 */
function formatMemory(mem: MemoryUnit): string {
  const storeLabel = mem.store === 'ltm' ? 'LTM' : 'STM';
  return `- [${storeLabel}] ${mem.summary}`;
}

/**
 * Format memories grouped by classification
 */
function formatMemoriesByClassification(
  memories: MemoryUnit[],
  classifications: MemoryClassification[]
): string[] {
  const lines: string[] = [];
  
  for (const classification of classifications) {
    const classMemories = memories.filter(m => m.classification === classification);
    if (classMemories.length === 0) continue;
    
    // Add header for this classification
    const header = classification.charAt(0).toUpperCase() + classification.slice(1);
    lines.push(`### ${header}`);
    lines.push('');
    
    // Add memories
    for (const mem of classMemories) {
      lines.push(formatMemory(mem));
    }
    lines.push('');
  }
  
  return lines;
}

// =============================================================================
// Claude Code Auto-Memory Writer
// =============================================================================

/**
 * Write memories to Claude Code's auto-memory system
 * 
 * Strategy:
 * 1. MEMORY.md contains user-level memories (constraints, preferences)
 *    - These are always loaded (first 200 lines)
 *    - Keep this file compact and high-priority
 * 2. Topic files contain detailed memories by category
 *    - Loaded on demand via @mention
 *    - Can be longer and more detailed
 */
export async function writeToAutoMemory(
  memories: MemoryUnit[],
  projectPath: string
): Promise<{ mainFile: string; topicFiles: string[] }> {
  const memoryDir = ensureMemoryDir(projectPath);
  const writtenFiles: string[] = [];
  
  // Separate user-level and project-level memories
  const userLevel = memories.filter(m => 
    USER_LEVEL_CLASSIFICATIONS.includes(m.classification)
  );
  const projectLevel = memories.filter(m => 
    !USER_LEVEL_CLASSIFICATIONS.includes(m.classification)
  );
  
  // === Write MEMORY.md (main file, loaded automatically) ===
  const mainLines: string[] = [
    '# PsychMem - Persistent Memory',
    '',
    '> Auto-generated by PsychMem. Do not edit directly.',
    '> These memories are loaded at the start of each Claude Code session.',
    '',
  ];
  
  // Add user-level memories (highest priority, always applicable)
  if (userLevel.length > 0) {
    mainLines.push('## User Preferences & Constraints');
    mainLines.push('_These apply across all projects_');
    mainLines.push('');
    mainLines.push(...formatMemoriesByClassification(userLevel, ['constraint', 'preference']));
    
    // Add learnings if space permits
    const learnings = userLevel.filter(m => 
      m.classification === 'learning' || m.classification === 'procedural'
    );
    if (learnings.length > 0 && mainLines.length < MAX_MEMORY_LINES - 20) {
      mainLines.push('## Learnings & Procedures');
      mainLines.push('');
      for (const mem of learnings) {
        mainLines.push(formatMemory(mem));
      }
      mainLines.push('');
    }
  }
  
  // Add project-level summary if space permits
  if (projectLevel.length > 0 && mainLines.length < MAX_MEMORY_LINES - 10) {
    const projectName = basename(projectPath);
    mainLines.push(`## ${projectName} Context`);
    mainLines.push(`_See topic files for details: @constraints, @learnings, @decisions, @bugfixes_`);
    mainLines.push('');
    
    // Add most important project memories (LTM only)
    const ltmProject = projectLevel.filter(m => m.store === 'ltm').slice(0, 5);
    for (const mem of ltmProject) {
      mainLines.push(formatMemory(mem));
    }
    mainLines.push('');
  }
  
  // Ensure we're under the line limit
  const truncatedMain = mainLines.slice(0, MAX_MEMORY_LINES);
  
  // Write MEMORY.md
  const mainFile = join(memoryDir, 'MEMORY.md');
  writeFileSync(mainFile, truncatedMain.join('\n'), 'utf-8');
  
  // === Write topic files (loaded on demand) ===
  for (const [topic, classifications] of Object.entries(TOPIC_FILES)) {
    const topicMemories = memories.filter(m => classifications.includes(m.classification));
    if (topicMemories.length === 0) continue;
    
    const topicLines: string[] = [
      `# ${topic.charAt(0).toUpperCase() + topic.slice(1)}`,
      '',
      '> Auto-generated by PsychMem. Mention @' + topic + ' to load.',
      '',
    ];
    
    topicLines.push(...formatMemoriesByClassification(topicMemories, classifications));
    
    const topicFile = join(memoryDir, `${topic}.md`);
    writeFileSync(topicFile, topicLines.join('\n'), 'utf-8');
    writtenFiles.push(topicFile);
  }
  
  return { mainFile, topicFiles: writtenFiles };
}

/**
 * Read existing memories from auto-memory files
 */
export function readFromAutoMemory(projectPath: string): string | null {
  const memoryDir = getMemoryDir(projectPath);
  const mainFile = join(memoryDir, 'MEMORY.md');
  
  if (!existsSync(mainFile)) {
    return null;
  }
  
  return readFileSync(mainFile, 'utf-8');
}

/**
 * List all topic files in a project's memory directory
 */
export function listTopicFiles(projectPath: string): string[] {
  const memoryDir = getMemoryDir(projectPath);
  
  if (!existsSync(memoryDir)) {
    return [];
  }
  
  return readdirSync(memoryDir)
    .filter(f => f.endsWith('.md') && f !== 'MEMORY.md')
    .map(f => join(memoryDir, f));
}

// =============================================================================
// Claude Code Adapter Class
// =============================================================================

/**
 * Claude Code adapter for PsychMem
 * 
 * Integrates with Claude Code's auto-memory system by:
 * 1. Writing memories to ~/.claude/projects/<project>/memory/
 * 2. Keeping MEMORY.md compact for automatic loading
 * 3. Organizing detailed memories in topic files
 */
export class ClaudeCodeAdapter implements PsychMemAdapter {
  readonly agentType = 'claude-code' as const;
  
  private psychmem: PsychMem | null = null;
  private db: MemoryDatabase | null = null;
  private retrieval: MemoryRetrieval | null = null;
  private config: PsychMemConfig;
  private currentSessionId: string | null = null;
  private currentProject: string | null = null;
  
  constructor(configOverrides: Partial<PsychMemConfig> = {}) {
    this.config = {
      ...DEFAULT_CONFIG,
      agentType: 'claude-code',
      ...configOverrides,
    };
  }
  
  /**
   * Initialize the adapter
   */
  async initialize(): Promise<void> {
    this.db = await createMemoryDatabase(this.config);
    this.psychmem = await createPsychMem(this.config);
    this.retrieval = new MemoryRetrieval(this.db, this.config);
  }
  
  /**
   * Set the current project context
   */
  setProject(projectPath: string): void {
    this.currentProject = projectPath;
  }
  
  /**
   * Inject memories into context
   * 
   * For Claude Code, this writes to the auto-memory directory.
   * The memories will be loaded automatically on next session.
   */
  async injectMemories(sessionId: string, memories: MemoryUnit[]): Promise<void> {
    this.currentSessionId = sessionId;
    
    if (!this.currentProject) {
      throw new Error('Project not set. Call setProject() first.');
    }
    
    if (memories.length === 0) {
      return;
    }
    
    await writeToAutoMemory(memories, this.currentProject);
  }
  
  /**
   * Sync memories to auto-memory files
   * 
   * Call this after session end to persist new memories
   * to Claude Code's auto-memory directory.
   */
  async syncToAutoMemory(): Promise<{ mainFile: string; topicFiles: string[] } | null> {
    if (!this.currentProject || !this.retrieval) {
      return null;
    }
    
    // Get all relevant memories for this project
    const memories = await this.retrieval.retrieveByScope({
      currentProject: this.currentProject,
      limit: 50, // Get more memories for file organization
    });
    
    if (memories.length === 0) {
      return null;
    }
    
    return writeToAutoMemory(memories, this.currentProject);
  }
  
  /**
   * Get current session ID
   */
  getCurrentSessionId(): string | null {
    return this.currentSessionId;
  }
  
  /**
   * Set current session ID
   */
  setCurrentSessionId(sessionId: string): void {
    this.currentSessionId = sessionId;
  }
  
  /**
   * Get relevant memories for injection
   */
  async getRelevantMemories(limit: number = 10): Promise<MemoryUnit[]> {
    if (!this.retrieval) {
      throw new Error('Adapter not initialized');
    }
    
    if (this.currentProject) {
      return this.retrieval.retrieveByScope({
        currentProject: this.currentProject,
        limit,
      });
    }
    
    // Fallback to basic search if no project set
    const index = this.retrieval.search('', undefined, limit);
    if (index.length === 0) {
      return [];
    }
    
    return this.retrieval.retrieveDetails(
      index.map(item => item.id),
      this.currentSessionId ?? undefined
    );
  }
  
  /**
   * Format memories for Claude Code context (inline format)
   */
  formatMemoriesForContext(memories: MemoryUnit[]): string {
    if (memories.length === 0) {
      return '';
    }
    
    const lines: string[] = [
      '## Relevant Memories from Previous Sessions',
      '',
    ];
    
    // Separate user-level and project-level
    const userLevel = memories.filter(m => 
      USER_LEVEL_CLASSIFICATIONS.includes(m.classification)
    );
    const projectLevel = memories.filter(m => 
      !USER_LEVEL_CLASSIFICATIONS.includes(m.classification)
    );
    
    if (userLevel.length > 0) {
      lines.push('### User Preferences & Constraints');
      lines.push('');
      for (const mem of userLevel) {
        lines.push(formatMemory(mem));
      }
      lines.push('');
    }
    
    if (projectLevel.length > 0) {
      lines.push('### Project Context');
      lines.push('');
      for (const mem of projectLevel) {
        lines.push(formatMemory(mem));
      }
      lines.push('');
    }
    
    return lines.join('\n');
  }
  
  /**
   * Get the underlying PsychMem instance
   */
  getPsychMem(): PsychMem {
    if (!this.psychmem) {
      throw new Error('Adapter not initialized');
    }
    return this.psychmem;
  }
  
  /**
   * Get the memory directory path for the current project
   */
  getMemoryDirectory(): string | null {
    if (!this.currentProject) {
      return null;
    }
    return getMemoryDir(this.currentProject);
  }
  
  /**
   * Cleanup resources
   */
  async cleanup(): Promise<void> {
    if (this.psychmem) {
      this.psychmem.close();
      this.psychmem = null;
    }
    this.db = null;
    this.retrieval = null;
    this.currentSessionId = null;
    this.currentProject = null;
  }
}

/**
 * Create a Claude Code adapter instance
 */
export function createClaudeCodeAdapter(
  config: Partial<PsychMemConfig> = {}
): ClaudeCodeAdapter {
  return new ClaudeCodeAdapter(config);
}

/**
 * Utility: Get the auto-memory path for a project (for external use)
 */
export function getClaudeCodeMemoryPath(projectPath: string): string {
  return getMemoryDir(projectPath);
}

/**
 * Utility: Convert project path to Claude Code project ID
 */
export function getClaudeCodeProjectId(projectPath: string): string {
  return projectPathToId(projectPath);
}

export default createClaudeCodeAdapter;
