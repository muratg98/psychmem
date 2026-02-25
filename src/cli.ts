#!/usr/bin/env node
/**
 * PsychMem CLI
 * 
 * Command-line interface for the selective memory system
 * 
 * Usage:
 *   psychmem install               Install PsychMem for OpenCode
 *   psychmem hook <json>           Process a hook event (stdin or arg)
 *   psychmem search <query>        Search memories
 *   psychmem get <id>              Get memory details
 *   psychmem stats                 Show memory statistics
 *   psychmem decay                 Apply decay to all memories
 *   psychmem consolidate           Run STM→LTM consolidation
 *   psychmem pin <id>              Pin a memory (prevent decay)
 *   psychmem forget <id>           Forget a memory
 *   psychmem remember <id>         Boost memory to LTM
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { PsychMem, createPsychMem } from './core.js';
import type { HookInput } from './types/index.js';

const args = process.argv.slice(2);
const command = args[0];

async function main() {
  // Install command doesn't need a PsychMem instance
  if (command === 'install') {
    await handleInstall();
    return;
  }

  const psychmem = await createPsychMem({ agentType: 'opencode' });
  
  try {
    switch (command) {
      case 'hook':
        await handleHook(psychmem, args.slice(1));
        break;
      
      case 'search':
        handleSearch(psychmem, args.slice(1));
        break;
      
      case 'list':
        handleList(psychmem, args.slice(1));
        break;
      
      case 'get': {
        const getId = args[1];
        if (!getId) {
          console.error('No memory ID provided.');
          process.exit(1);
        }
        handleGet(psychmem, getId);
        break;
      }
      
      case 'stats':
        handleStats(psychmem);
        break;
      
      case 'decay':
        handleDecay(psychmem);
        break;
      
      case 'consolidate':
        handleConsolidate(psychmem);
        break;
      
      case 'pin': {
        const pinId = args[1];
        if (!pinId) {
          console.error('No memory ID provided.');
          process.exit(1);
        }
        handlePin(psychmem, pinId);
        break;
      }
      
      case 'forget': {
        const forgetId = args[1];
        if (!forgetId) {
          console.error('No memory ID provided.');
          process.exit(1);
        }
        handleForget(psychmem, forgetId);
        break;
      }
      
      case 'remember': {
        const rememberId = args[1];
        if (!rememberId) {
          console.error('No memory ID provided.');
          process.exit(1);
        }
        handleRemember(psychmem, rememberId);
        break;
      }
      
      case 'help':
      case '--help':
      case '-h':
        printHelp();
        break;
      
      default:
        console.error(`Unknown command: ${command}`);
        printHelp();
        process.exit(1);
    }
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  } finally {
    psychmem.close();
  }
}

// ---------------------------------------------------------------------------
// Install command
// ---------------------------------------------------------------------------

async function handleInstall() {
  await installForOpenCode();
}

async function installForOpenCode() {
  console.log('\nInstalling PsychMem for OpenCode...');

  const configDir = path.join(os.homedir(), '.config', 'opencode');
  const pluginsDir = path.join(configDir, 'plugins');
  const pkgPath = path.join(configDir, 'package.json');

  // 1. Ensure plugins dir exists
  fs.mkdirSync(pluginsDir, { recursive: true });

  // 2. Write plugin file (mirrors plugin.js — includes env var config)
  const pluginFile = path.join(pluginsDir, 'psychmem.js');
  const pluginContent = `import { createOpenCodePlugin } from "psychmem/adapters/opencode";

function parseEnvBool(value, defaultValue) {
  if (value === undefined) return defaultValue;
  return value.toLowerCase() === 'true' || value === '1';
}

function parseEnvNumber(value, defaultValue) {
  if (value === undefined) return defaultValue;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

function parseEnvFloat(value, defaultValue) {
  if (value === undefined) return defaultValue;
  const parsed = parseFloat(value);
  return isNaN(parsed) ? defaultValue : parsed;
}

export const PsychMem = async (ctx) => {
  const config = {
    opencode: {
      injectOnCompaction: parseEnvBool(process.env.PSYCHMEM_INJECT_ON_COMPACTION, true),
      extractOnCompaction: parseEnvBool(process.env.PSYCHMEM_EXTRACT_ON_COMPACTION, true),
      extractOnMessage: parseEnvBool(process.env.PSYCHMEM_EXTRACT_ON_MESSAGE, true),
      maxCompactionMemories: parseEnvNumber(process.env.PSYCHMEM_MAX_COMPACTION_MEMORIES, 10),
      maxSessionStartMemories: parseEnvNumber(process.env.PSYCHMEM_MAX_SESSION_MEMORIES, 10),
      messageWindowSize: parseEnvNumber(process.env.PSYCHMEM_MESSAGE_WINDOW_SIZE, 3),
      messageImportanceThreshold: parseEnvFloat(process.env.PSYCHMEM_MESSAGE_IMPORTANCE_THRESHOLD, 0.5),
    },
  };
  return await createOpenCodePlugin(ctx, config);
};
`;
  fs.writeFileSync(pluginFile, pluginContent, 'utf8');
  console.log(`  ✓ Plugin file written: ${pluginFile}`);

  // 3. Update package.json
  let pkg: Record<string, any> = {};
  if (fs.existsSync(pkgPath)) {
    try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch {}
  }
  if (!pkg.dependencies) pkg.dependencies = {};
  pkg.dependencies['psychmem'] = 'latest';
  if (!pkg.dependencies['@opencode-ai/plugin']) {
    pkg.dependencies['@opencode-ai/plugin'] = 'latest';
  }
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  console.log(`  ✓ package.json updated: ${pkgPath}`);

  // 4. Run bun install
  console.log('  Running bun install...');
  try {
    execSync('bun install', { cwd: configDir, stdio: 'inherit' });
    console.log('  ✓ Dependencies installed');
  } catch {
    console.warn('  ! bun install failed. Run it manually in: ' + configDir);
  }

  console.log('\nOpenCode installation complete.');
  console.log('Restart OpenCode to activate PsychMem.\n');
}

async function handleHook(psychmem: PsychMem, args: string[]) {
  let inputJson: string;
  
  if (args.length > 0) {
    inputJson = args.join(' ');
  } else {
    // Read from stdin
    inputJson = await readStdin();
  }
  
  if (!inputJson.trim()) {
    console.error('No input provided. Pass JSON as argument or via stdin.');
    process.exit(1);
  }
  
  let input: HookInput;
  try {
    input = JSON.parse(inputJson);
  } catch (e) {
    process.stderr.write(JSON.stringify({
      error: 'invalid_json',
      message: e instanceof Error ? e.message : String(e),
    }) + '\n');
    process.exit(1);
  }
  
  const result = await psychmem.handleHook(input);
  
  if (result.success) {
    if (result.context) {
      console.log(JSON.stringify({ context: result.context }));
    } else {
      console.log(JSON.stringify({ continue: true }));
    }
  } else {
    // Don't block on errors, just log
    console.error(result.error);
    process.exit(0); // Still exit 0 so we don't block the agent
  }
}

function handleSearch(psychmem: PsychMem, args: string[]) {
  const query = args.join(' ');
  
  if (!query) {
    console.error('No search query provided.');
    process.exit(1);
  }
  
  const results = psychmem.search(query);
  
  if (results.length === 0) {
    console.log('No memories found.');
    return;
  }
  
  console.log(`Found ${results.length} memories:\n`);
  
  for (const item of results) {
    const bar = formatStrengthBar(item.strength);
    const store = item.store === 'ltm' ? 'LTM' : 'STM';
    console.log(`${bar} [${store}] ${item.summary}`);
    console.log(`    ID: ${item.id.slice(0, 8)} | ${item.classification} | ~${item.estimatedTokens} tokens\n`);
  }
}

function handleList(psychmem: PsychMem, args: string[]) {
  // Parse optional flags: --store stm|ltm  --status active|decayed|pinned  --limit N
  let store: 'stm' | 'ltm' | undefined;
  let status: 'active' | 'decayed' | 'pinned' | 'forgotten' = 'active';
  let limit = 50;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--store' && args[i + 1]) {
      const v = args[++i]!;
      if (v === 'stm' || v === 'ltm') store = v;
    } else if (args[i] === '--status' && args[i + 1]) {
      const v = args[++i] as any;
      if (['active', 'decayed', 'pinned', 'forgotten'].includes(v)) status = v;
    } else if (args[i] === '--limit' && args[i + 1]) {
      limit = parseInt(args[++i]!, 10) || 50;
    }
  }

  const memories = psychmem.listMemories(store !== undefined ? { store, status, limit } : { status, limit });

  if (memories.length === 0) {
    console.log(`No ${status} memories found.`);
    return;
  }

  console.log(`${memories.length} ${status.toUpperCase()} memories (sorted by strength):\n`);
  for (const mem of memories) {
    const bar = formatStrengthBar(mem.strength);
    const storeLabel = mem.store === 'ltm' ? 'LTM' : 'STM';
    const date = mem.createdAt.toISOString().slice(0, 10);
    console.log(`${bar} [${storeLabel}] [${mem.classification}] ${mem.summary}`);
    console.log(`    ID: ${mem.id.slice(0, 8)} | strength: ${(mem.strength * 100).toFixed(1)}% | created: ${date}\n`);
  }
}

function handleGet(psychmem: PsychMem, id: string) {
  const memory = psychmem.getMemory(id);
  
  if (!memory) {
    console.error(`Memory not found: ${id}`);
    process.exit(1);
  }
  
  console.log('Memory Details:\n');
  console.log(`ID: ${memory.id}`);
  console.log(`Store: ${memory.store.toUpperCase()}`);
  console.log(`Classification: ${memory.classification}`);
  console.log(`Status: ${memory.status}`);
  console.log(`Strength: ${formatStrengthBar(memory.strength)} (${(memory.strength * 100).toFixed(1)}%)`);
  console.log(`\nSummary:\n${memory.summary}`);
  console.log(`\nScores:`);
  console.log(`  Importance: ${memory.importance.toFixed(2)}`);
  console.log(`  Utility: ${memory.utility.toFixed(2)}`);
  console.log(`  Novelty: ${memory.novelty.toFixed(2)}`);
  console.log(`  Confidence: ${memory.confidence.toFixed(2)}`);
  console.log(`  Interference: ${memory.interference.toFixed(2)}`);
  console.log(`\nMetadata:`);
  console.log(`  Created: ${memory.createdAt.toISOString()}`);
  console.log(`  Updated: ${memory.updatedAt.toISOString()}`);
  console.log(`  Frequency: ${memory.frequency}`);
  console.log(`  Tags: ${memory.tags.join(', ') || 'none'}`);
}

function handleStats(psychmem: PsychMem) {
  const stats = psychmem.getStats();
  
  console.log('PsychMem Statistics:\n');
  console.log(`Active Memories: ${stats.total}`);
  console.log(`Total (incl. decayed): ${stats.totalIncludingDecayed}`);
  console.log(`\nShort-Term Memory (STM):`);
  console.log(`  Active: ${stats.stm.count}`);
  console.log(`  Decayed: ${stats.stm.decayedCount}`);
  console.log(`  Pinned: ${stats.stm.pinnedCount}`);
  console.log(`  Avg Strength (active): ${(stats.stm.avgStrength * 100).toFixed(1)}%`);
  console.log(`\nLong-Term Memory (LTM):`);
  console.log(`  Active: ${stats.ltm.count}`);
  console.log(`  Decayed: ${stats.ltm.decayedCount}`);
  console.log(`  Pinned: ${stats.ltm.pinnedCount}`);
  console.log(`  Avg Strength (active): ${(stats.ltm.avgStrength * 100).toFixed(1)}%`);
}

function handleDecay(psychmem: PsychMem) {
  const decayed = psychmem.applyDecay();
  console.log(`Decay applied. ${decayed} memories fell below threshold.`);
}

function handleConsolidate(psychmem: PsychMem) {
  const promoted = psychmem.runConsolidation();
  console.log(`Consolidation complete. ${promoted} memories promoted to LTM.`);
}

function handlePin(psychmem: PsychMem, id: string) {
  psychmem.pinMemory(id);
  console.log(`Memory ${id.slice(0, 8)} pinned. It will not decay.`);
}

function handleForget(psychmem: PsychMem, id: string) {
  psychmem.forgetMemory(id);
  console.log(`Memory ${id.slice(0, 8)} forgotten.`);
}

function handleRemember(psychmem: PsychMem, id: string) {
  psychmem.rememberMemory(id);
  console.log(`Memory ${id.slice(0, 8)} marked as important and promoted to LTM.`);
}

function formatStrengthBar(strength: number): string {
  const filled = Math.round(strength * 5);
  const empty = 5 - filled;
  return '[' + '█'.repeat(filled) + '░'.repeat(empty) + ']';
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      resolve(data);
    });
  });
}

function printHelp() {
  console.log(`
PsychMem - Psych-grounded selective memory system for AI agents

USAGE:
  psychmem <command> [arguments]

COMMANDS:
  install            Install PsychMem for OpenCode
  hook <json>        Process a hook event (JSON as argument or stdin)
  list               List memories (default: active, sorted by strength)
                       --store stm|ltm    Filter by store
                       --status active|decayed|pinned|forgotten
                       --limit N          Max results (default: 50)
  search <query>     Search memories by text query
  get <id>           Get full memory details by ID
  stats              Show memory statistics
  decay              Apply decay to all memories
  consolidate        Run STM to LTM consolidation
  pin <id>           Pin a memory (prevent decay)
  forget <id>        Forget a memory
  remember <id>      Mark memory as important (promote to LTM)
  help               Show this help message

EXAMPLES:
  # Install for OpenCode
  psychmem install

  # List active memories
  psychmem list

  # List all memories including decayed
  psychmem list --status decayed

  # Search for memories about errors
  psychmem search "error handling"

  # Get memory details
  psychmem get a1b2c3d4

  # View stats
  psychmem stats

For more information, see: https://github.com/muratg98/psychmem
`);
}

main().catch(console.error);
