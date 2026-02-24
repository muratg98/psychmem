#!/usr/bin/env node
/**
 * PsychMem CLI
 * 
 * Command-line interface for the selective memory system
 * 
 * Usage:
 *   psychmem install               Install PsychMem (interactive)
 *   psychmem install --opencode    Install for OpenCode only
 *   psychmem install --claude      Install for Claude Code only
 *   psychmem install --both        Install for both agents
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
import { fileURLToPath } from 'url';
import { PsychMem, createPsychMem } from './core.js';
import type { HookInput } from './types/index.js';
import { TranscriptParser } from './transcript/parser.js';

const rawArgs = process.argv.slice(2);

// Parse --agent <type> flag (default: opencode)
let agentType: 'opencode' | 'claude-code' = 'opencode';
const filteredArgs: string[] = [];
for (let i = 0; i < rawArgs.length; i++) {
  if (rawArgs[i] === '--agent' && rawArgs[i + 1]) {
    const val = rawArgs[++i];
    if (val === 'opencode' || val === 'claude-code') {
      agentType = val;
    } else {
      console.error(`Unknown agent type: ${val}. Use 'opencode' or 'claude-code'.`);
      process.exit(1);
    }
  } else {
    filteredArgs.push(rawArgs[i]!);
  }
}

const args = filteredArgs;
const command = args[0];

async function main() {
  // Install command doesn't need a PsychMem instance
  if (command === 'install') {
    await handleInstall(args.slice(1));
    return;
  }

  const psychmem = await createPsychMem({ agentType });
  
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

async function handleInstall(installArgs: string[]) {
  const forOpenCode = installArgs.includes('--opencode') || installArgs.includes('--both');
  const forClaude = installArgs.includes('--claude') || installArgs.includes('--both');
  const hasFlag = forOpenCode || forClaude;

  let installOpenCode = forOpenCode;
  let installClaude = forClaude;

  if (!hasFlag) {
    // Interactive prompt
    const answer = await prompt(
      'Which agent would you like to install PsychMem for?\n' +
      '  1) OpenCode\n' +
      '  2) Claude Code\n' +
      '  3) Both\n' +
      'Enter 1, 2, or 3: '
    );
    const trimmed = answer.trim();
    if (trimmed === '1') {
      installOpenCode = true;
    } else if (trimmed === '2') {
      installClaude = true;
    } else if (trimmed === '3') {
      installOpenCode = true;
      installClaude = true;
    } else {
      console.error('Invalid choice. Run `psychmem install --opencode`, `--claude`, or `--both`.');
      process.exit(1);
    }
  }

  if (installOpenCode) await installForOpenCode();
  if (installClaude) await installForClaude();
}

function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.resume();
    process.stdin.once('data', (chunk) => {
      data += chunk;
      process.stdin.pause();
      resolve(data.split('\n')[0] ?? '');
    });
  });
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

async function installForClaude() {
  console.log('\nInstalling PsychMem for Claude Code...');

  const claudeDir = path.join(os.homedir(), '.claude');
  const settingsPath = path.join(claudeDir, 'settings.json');

  // Resolve the psychmem package root (where this CLI binary lives)
  // When installed via npm, import.meta.url points to dist/cli.js inside the package
  const packageRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..');

  // 1. Load existing settings
  let settings: Record<string, any> = {};
  if (fs.existsSync(settingsPath)) {
    try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch {}
  } else {
    fs.mkdirSync(claudeDir, { recursive: true });
  }

  // 2. Load our hooks.json
  const hooksJsonPath = path.join(packageRoot, 'hooks', 'hooks.json');
  if (!fs.existsSync(hooksJsonPath)) {
    console.error(`  ! hooks/hooks.json not found at ${hooksJsonPath}`);
    process.exit(1);
  }
  const psychmemHooks = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8')) as {
    hooks: Record<string, Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>>;
  };

  // 3. Resolve the CLI path and replace placeholder
  const cliPath = path.join(packageRoot, 'dist', 'cli.js');
  const hookCommand = `node "${cliPath}" hook --agent claude-code`;

  // 4. Merge hooks into settings
  if (!settings.hooks) settings.hooks = {};

  for (const [eventName, eventHooks] of Object.entries(psychmemHooks.hooks)) {
    if (!settings.hooks[eventName]) settings.hooks[eventName] = [];

    for (const group of eventHooks) {
      // Replace each hook command with the resolved path
      const resolvedHooks = group.hooks.map((h) => ({
        ...h,
        command: hookCommand,
      }));

      const entry: Record<string, unknown> = { hooks: resolvedHooks };
      if (group.matcher) entry['matcher'] = group.matcher;

      // Avoid duplicate entries
      const alreadyExists = (settings.hooks[eventName] as any[]).some(
        (e: any) => e.hooks?.some((h: any) => (h.command as string)?.includes('psychmem'))
      );
      if (!alreadyExists) {
        settings.hooks[eventName].push(entry);
      }
    }
  }

  // 5. Write back
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  console.log(`  ✓ Hooks merged into: ${settingsPath}`);
  console.log(`  ✓ Using CLI at: ${cliPath}`);

  console.log('\nClaude Code installation complete.');
  console.log('Restart Claude Code to activate PsychMem.\n');
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
  
  let rawInput: Record<string, unknown>;
  try {
    rawInput = JSON.parse(inputJson);
  } catch (e) {
    process.stderr.write(JSON.stringify({
      error: 'invalid_json',
      message: e instanceof Error ? e.message : String(e),
    }) + '\n');
    process.exit(1);
  }
  
  // Transform Claude Code hook input to our internal format
  const input = await transformClaudeCodeInput(rawInput);
  const result = await psychmem.handleHook(input);
  
  // Transform output for Claude Code format
  if (result.success) {
    if (result.context) {
      // For SessionStart, output context as additionalContext for Claude
      // For other hooks, just output the context
      if (input.hookType === 'SessionStart') {
        console.log(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'SessionStart',
            additionalContext: result.context
          }
        }));
      } else {
        // For Stop/SessionEnd, just output status (not blocking)
        console.log(JSON.stringify({ continue: true }));
      }
    } else {
      console.log(JSON.stringify({ continue: true }));
    }
  } else {
    // Don't block on errors, just log
    console.error(result.error);
    process.exit(0); // Still exit 0 so we don't block the agent
  }
}

/**
 * Transform Claude Code hook input to PsychMem internal format
 * Claude Code sends: hook_event_name, session_id, cwd, transcript_path, etc.
 * We expect: hookType, sessionId, timestamp, data
 */
async function transformClaudeCodeInput(raw: Record<string, unknown>): Promise<HookInput> {
  // Detect if this is already in our internal format
  if (raw.hookType && raw.data) {
    return raw as unknown as HookInput;
  }
  
  // Transform from Claude Code format
  const hookEventName = raw.hook_event_name as string;
  const sessionId = raw.session_id as string;
  const cwd = raw.cwd as string;
  const transcriptPath = raw.transcript_path as string;
  
  // Map Claude Code event names to our internal hook types
  const hookTypeMap: Record<string, string> = {
    'SessionStart': 'SessionStart',
    'UserPromptSubmit': 'UserPromptSubmit',
    'PostToolUse': 'PostToolUse',
    'Stop': 'Stop',
    'SessionEnd': 'SessionEnd',
  };
  
  const hookType = hookTypeMap[hookEventName] ?? hookEventName;
  
  // Build the data object based on hook type
  let data: Record<string, unknown> = {};
  
  switch (hookType) {
    case 'SessionStart': {
      // Extract project name from cwd, stripping any trailing slash first
      const normalizedCwd = cwd ? cwd.replace(/[/\\]+$/, '') : '';
      const project = normalizedCwd ? normalizedCwd.split(/[/\\]/).pop() ?? 'unknown' : 'unknown';
      const source = raw.source as string | undefined;
      data = {
        project,
        workingDirectory: cwd,
        source,
        metadata: { transcriptPath }
      };
      break;
    }
    
    case 'UserPromptSubmit': {
      const prompt = raw.prompt as string | undefined;
      data = {
        prompt: prompt ?? '',
        metadata: { cwd }
      };
      break;
    }
    
    case 'PostToolUse': {
      const toolName = raw.tool_name as string | undefined;
      const toolInput = raw.tool_input as Record<string, unknown> | undefined;
      const toolResponse = raw.tool_response as Record<string, unknown> | undefined;
      data = {
        toolName: toolName ?? 'unknown',
        toolInput: toolInput ? JSON.stringify(toolInput) : '',
        toolOutput: toolResponse ? JSON.stringify(toolResponse) : '',
        success: true,
        metadata: { cwd }
      };
      break;
    }
    
    case 'Stop': {
      const stopReason = raw.stop_reason as string | undefined;
      // Read the full transcript to provide conversationText for memory extraction
      let conversationText: string | undefined;
      if (transcriptPath) {
        try {
          const parser = new TranscriptParser();
          const parseResult = await parser.parseFromWatermark(transcriptPath, 0);
          if (parseResult.entries.length > 0) {
            conversationText = TranscriptParser.entriesToConversationText(parseResult.entries);
          }
        } catch (e) {
          process.stderr.write(`[psychmem] Warning: could not read transcript at ${transcriptPath}: ${e instanceof Error ? e.message : String(e)}\n`);
        }
      }
      data = {
        reason: 'user' as const,
        stopReason,
        ...(conversationText !== undefined ? { conversationText } : {}),
        metadata: { transcriptPath, cwd }
      };
      break;
    }
    
    case 'SessionEnd': {
      data = {
        reason: 'normal' as const,
        metadata: { transcriptPath, cwd }
      };
      break;
    }
    
    default:
      data = raw as Record<string, unknown>;
  }
  
  return {
    hookType: hookType as HookInput['hookType'],
    sessionId,
    timestamp: new Date().toISOString(),
    data: data as unknown as HookInput['data'],
  };
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
  psychmem [--agent opencode|claude-code] <command> [arguments]

FLAGS:
  --agent <type>     Agent type to use (default: opencode)
                     Options: opencode, claude-code

COMMANDS:
  install            Install PsychMem (interactive - asks which agent)
  install --opencode Install for OpenCode only
  install --claude   Install for Claude Code only
  install --both     Install for both agents
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
  # Install interactively
  psychmem install

  # Install for a specific agent
  psychmem install --opencode
  psychmem install --claude
  psychmem install --both

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

  # Use with Claude Code agent
  psychmem --agent claude-code stats

For more information, see: https://github.com/muratg98/psychmem
`);
}

main().catch(console.error);
