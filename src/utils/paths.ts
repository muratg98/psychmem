/**
 * Path utilities for PsychMem
 */

import { homedir } from 'os';
import { join, dirname } from 'path';
import { mkdirSync, existsSync } from 'fs';
import type { AgentType } from '../types/index.js';

/**
 * Resolve database path, expanding ~ and {agentType} template
 * @param dbPath - Path template (e.g., '~/.psychmem/{agentType}/memory.db')
 * @param agentType - Agent type to substitute (e.g., 'opencode')
 */
export function resolveDbPath(dbPath: string, agentType: AgentType = 'opencode'): string {
  let resolved = dbPath;
  
  // Replace {agentType} template with actual agent type
  resolved = resolved.replace(/{agentType}/g, agentType);
  
  // Expand ~ to home directory
  if (resolved.startsWith('~')) {
    resolved = join(homedir(), resolved.slice(1));
  }
  
  // Ensure directory exists
  const dir = dirname(resolved);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  
  return resolved;
}

/**
 * Get the default data directory for a specific agent type
 */
export function getDataDir(agentType: AgentType = 'opencode'): string {
  const dataDir = join(homedir(), '.psychmem', agentType);
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }
  return dataDir;
}

/**
 * Get the default database path for a specific agent type
 */
export function getDefaultDbPath(agentType: AgentType = 'opencode'): string {
  return join(getDataDir(agentType), 'memory.db');
}
