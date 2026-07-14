#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { initDb, getDbPath, getFileIngestState, saveSessionEpisodes, getAllEpisodes, getEpisodeById, getStepsForEpisode, DbEpisode, DbStep } from "../src/store";
import { streamClaudeLog } from "../src/sources/claude";
import { streamCodexLog, findCodexFiles, getCodexFileMeta } from "../src/sources/codex";
import { findCursorFiles, streamCursorLog } from "../src/sources/cursor";
import { findDevinSessions, streamDevinLog } from "../src/sources/devin";
import { findOpenCodeSessions, streamOpenCodeLog } from "../src/sources/opencode";
import { parseEpisodes, EpisodeData, EpisodeStep } from "../src/episodes";
import { generateTrendsMarkdown } from "../src/trends";
import {
  ingestSemanticTelemetry,
  migrateLegacyDatabase,
  openRedactedDatabase,
} from "../src/semantic/redacted-store";
import { generateAdoptionReport } from "../src/semantic/report";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { createInterface } from "readline";

function printUsage() {
  console.log(`
Usage: git-mine <command> [arguments]

Commands:
  extract [--tool <claude|codex|cursor|devin|opencode>] [--since <date>] [--cwd <path>]
                     Scan and ingest log files into the database.
  episodes           List all ingested episodes.
  trends [--tool <claude|codex|cursor|devin|opencode>]
                     Display the markdown trends table of episode shapes.
  show <episode-id>  Show detailed steps and reasoning for a specific episode.
  semantic-migrate --source <legacy.db> --destination <redacted.db>
                     Create a separate content-redacted database from legacy data.
  semantic-ingest --input <telemetry.jsonl> --database <redacted.db>
                     Ingest strict metadata-only semantic telemetry.
  semantic-report --database <redacted.db>
                     Output adoption, correctness, operation, token, and latency metrics as JSON.
`);
}

const requireOption = (value: string | undefined, flag: string) => {
  if (!value) throw new Error(`Missing required option: ${flag}`);
  return value;
};

const handleSemanticMigrate = (options: { source?: string; destination?: string }) => {
  const outcome = migrateLegacyDatabase({
    sourcePath: requireOption(options.source, "--source"),
    destinationPath: requireOption(options.destination, "--destination"),
  });
  console.log(JSON.stringify(outcome));
};

const handleSemanticIngest = async (options: { input?: string; database?: string }) => {
  const databasePath = requireOption(options.database, "--database");
  const inputPath = requireOption(options.input, "--input");
  const database = openRedactedDatabase(databasePath);
  try {
    const outcome = await ingestSemanticTelemetry(database, inputPath);
    console.log(JSON.stringify(outcome));
  } finally {
    database.close();
  }
};

const handleSemanticReport = (options: { database?: string }) => {
  const databasePath = requireOption(options.database, "--database");
  if (!fs.existsSync(databasePath)) throw new Error(`Database does not exist: ${databasePath}`);
  const database = new Database(databasePath, { readonly: true });
  try {
    console.log(JSON.stringify(generateAdoptionReport(database)));
  } finally {
    database.close();
  }
};

function findJsonlFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  const items = fs.readdirSync(dir, { withFileTypes: true });
  for (const item of items) {
    const fullPath = path.join(dir, item.name);
    if (item.isDirectory()) {
      results.push(...findJsonlFiles(fullPath));
    } else if (item.isFile() && item.name.endsWith(".jsonl")) {
      results.push(fullPath);
    }
  }
  return results;
}

async function getFileCwd(filePath: string, tool: string): Promise<string | null> {
  if (filePath.startsWith("devin://") || filePath.startsWith("opencode://")) return null;
  if (!fs.existsSync(filePath)) return null;
  const fileStream = fs.createReadStream(filePath);
  const rl = createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (tool === "codex") {
        if (trimmed.includes('"type":"session_meta"')) {
          const obj = JSON.parse(trimmed);
          if (obj.type === "session_meta" && obj.payload) {
            return obj.payload.cwd || null;
          }
        }
      } else if (tool === "claude") {
        if (trimmed.includes('"cwd":')) {
          const obj = JSON.parse(trimmed);
          return obj.cwd || null;
        }
      } else if (tool === "cursor") {
        return null;
      }
    }
  } catch (e) {
  } finally {
    rl.close();
  }
  return null;
}

interface IngestTarget {
  filePath: string;
  sessionId: string;
  mtimeMs: number;
  workingDirectory?: string;
}

async function handleExtract(options: { tool?: string; since?: string; cwd?: string }) {
  const tool = (options.tool || "claude").toLowerCase();
  const supportedTools = ["claude", "codex", "cursor", "devin", "opencode"];
  if (!supportedTools.includes(tool)) {
    console.error(`Error: Unsupported tool '${tool}'. Supported tools are: ${supportedTools.join(", ")}.`);
    process.exit(1);
  }

  const dbPath = getDbPath();
  const db = initDb(dbPath);
  console.log(`Using database at: ${dbPath}`);

  const sinceDate = options.since ? new Date(options.since) : null;
  if (options.since && isNaN(sinceDate!.getTime())) {
    console.error(`Error: Invalid date format for --since: ${options.since}`);
    process.exit(1);
  }

  let targets: IngestTarget[] = [];
  if (tool === "claude") {
    const projectsDir = path.join(os.homedir(), ".claude", "projects");
    if (!fs.existsSync(projectsDir)) {
      console.error(`Error: Claude projects directory not found at ${projectsDir}`);
      process.exit(1);
    }
    console.log(`Scanning for Claude Code log files under ${projectsDir}...`);
    const files = findJsonlFiles(projectsDir);
    targets = files.map(file => {
      const stat = fs.statSync(file);
      return {
        filePath: file,
        sessionId: path.basename(file, ".jsonl"),
        mtimeMs: Math.round(stat.mtimeMs),
      };
    });
  } else if (tool === "codex") {
    console.log(`Scanning for Codex log files...`);
    const files = findCodexFiles(sinceDate);
    for (const file of files) {
      const stat = fs.statSync(file);
      let sessionId = path.basename(file, ".jsonl");
      const meta = await getCodexFileMeta(file);
      if (meta && meta.sessionId) {
        sessionId = meta.sessionId;
      }
      targets.push({
        filePath: file,
        sessionId,
        mtimeMs: Math.round(stat.mtimeMs),
      });
    }
  } else if (tool === "cursor") {
    console.log(`Scanning for Cursor log files...`);
    const files = findCursorFiles(sinceDate);
    targets = files.map(file => {
      const stat = fs.statSync(file);
      return {
        filePath: file,
        sessionId: path.basename(file, ".jsonl"),
        mtimeMs: Math.round(stat.mtimeMs),
      };
    });
  } else if (tool === "devin") {
    console.log(`Scanning for Devin sessions...`);
    const sessions = findDevinSessions(sinceDate);
    targets = sessions.map(s => ({
      filePath: s.filePath,
      sessionId: s.sessionId,
      mtimeMs: s.mtimeMs,
      workingDirectory: s.workingDirectory,
    }));
  } else if (tool === "opencode") {
    console.log(`Scanning for OpenCode sessions...`);
    const sessions = findOpenCodeSessions(sinceDate);
    targets = sessions.map(s => ({
      filePath: s.filePath,
      sessionId: s.sessionId,
      mtimeMs: s.mtimeMs,
      workingDirectory: s.workingDirectory,
    }));
  }

  console.log(`Found ${targets.length} target(s).`);

  let ingestedCount = 0;
  let cachedCount = 0;
  let skippedCwdCount = 0;

  for (const target of targets) {
    const { filePath, sessionId, mtimeMs } = target;
    const isVirtual = filePath.startsWith("devin://") || filePath.startsWith("opencode://");
    const fileSize = isVirtual ? 0 : fs.statSync(filePath).size;

    // Prune Claude and Cursor files by mtime if sinceDate is specified
    if ((tool === "claude" || tool === "cursor") && sinceDate && mtimeMs < sinceDate.getTime()) {
      cachedCount++;
      continue;
    }

    // Filter by CWD if specified
    if (options.cwd) {
      let fileCwd = target.workingDirectory || null;
      if (!fileCwd) {
        fileCwd = await getFileCwd(filePath, tool);
      }
      if (!fileCwd) {
        skippedCwdCount++;
        continue;
      }
      const absFilter = path.resolve(options.cwd);
      const absFileCwd = path.resolve(fileCwd);
      if (absFilter !== absFileCwd && !absFileCwd.endsWith(options.cwd)) {
        skippedCwdCount++;
        continue;
      }
    }

    // Check if target is already ingested and unchanged
    const state = getFileIngestState(db, filePath);
    if (state && state.file_size === fileSize && state.mtime_ms === mtimeMs) {
      cachedCount++;
      continue;
    }

    console.log(`Processing: ${isVirtual ? filePath : path.relative(os.homedir(), filePath)}...`);
    try {
      let eventStream;
      if (tool === "claude") {
        eventStream = streamClaudeLog(filePath);
      } else if (tool === "codex") {
        eventStream = streamCodexLog(filePath);
      } else if (tool === "cursor") {
        eventStream = streamCursorLog(filePath);
      } else if (tool === "devin") {
        eventStream = streamDevinLog(sessionId);
      } else {
        eventStream = streamOpenCodeLog(sessionId);
      }

      const episodes = await parseEpisodes(eventStream, sessionId);

      // Convert EpisodeData[] to DbEpisode[] and DbStep[]
      const dbEps: DbEpisode[] = episodes.map(ep => ({
        id: ep.id,
        session_id: ep.session_id,
        intent: ep.intent,
        intent_source: ep.intent_source,
        reasoning: ep.reasoning,
        llm_ops: ep.llm_ops,
        context_ops: ep.context_ops,
        outcome: ep.outcome,
        shape: ep.shape,
        ts: ep.ts,
        tool,
      }));

      const dbSteps: DbStep[] = [];
      for (const ep of episodes) {
        let stepIdx = 0;
        for (const step of ep.steps) {
          dbSteps.push({
            id: `${ep.id}_${stepIdx}`,
            episode_id: ep.id,
            step_index: stepIdx,
            command: step.command,
            raw_command: step.raw_command,
            output: step.output ?? null,
            exit_code: step.exit_code ?? null,
            is_error: step.is_error ? 1 : 0,
            ts: step.ts,
          });
          stepIdx++;
        }
      }

      saveSessionEpisodes(db, filePath, fileSize, mtimeMs, sessionId, dbEps, dbSteps);
      ingestedCount++;
      console.log(`  -> Ingested ${episodes.length} episode(s).`);
    } catch (e) {
      console.error(`  -> Failed to ingest ${filePath}:`, e);
    }
  }

  console.log(`\nExtraction completed:`);
  console.log(`- Ingested targets: ${ingestedCount}`);
  console.log(`- Cached targets: ${cachedCount}`);
  if (options.cwd) {
    console.log(`- Skipped by CWD filter: ${skippedCwdCount}`);
  }
  const totalEps = db.prepare("SELECT COUNT(*) as count FROM episodes").get() as { count: number };
  console.log(`- Total episodes in DB: ${totalEps.count}`);
}

function handleEpisodes() {
  const db = initDb(getDbPath());
  const episodes = getAllEpisodes(db);

  if (episodes.length === 0) {
    console.log("No episodes found. Please run 'extract' first.");
    return;
  }

  console.log(`Found ${episodes.length} episode(s):\n`);
  console.log(
    String("Episode ID").padEnd(45) +
    String("Tool").padEnd(10) +
    String("Date").padEnd(25) +
    String("Ops").padEnd(6) +
    String("Outcome").padEnd(15) +
    String("Shape").padEnd(30) +
    "Intent"
  );
  console.log("-".repeat(160));

  for (const ep of episodes) {
    const dateStr = new Date(ep.ts).toLocaleString();
    const intentSnippet = ep.intent.replace(/\r?\n/g, " ").slice(0, 50);
    console.log(
      ep.id.padEnd(45) +
      ep.tool.padEnd(10) +
      dateStr.padEnd(25) +
      String(ep.llm_ops).padEnd(6) +
      ep.outcome.padEnd(15) +
      ep.shape.padEnd(30) +
      intentSnippet
    );
  }
}

function handleShow(episodeId: string) {
  if (!episodeId) {
    console.error("Error: Please specify an episode ID.");
    printUsage();
    process.exit(1);
  }

  const db = initDb(getDbPath());
  const ep = getEpisodeById(db, episodeId);
  if (!ep) {
    console.error(`Error: Episode with ID '${episodeId}' not found.`);
    process.exit(1);
  }

  const steps = getStepsForEpisode(db, episodeId);

  console.log(`==================================================`);
  console.log(`EPISODE DETAILS`);
  console.log(`==================================================`);
  console.log(`ID:         ${ep.id}`);
  console.log(`Session:    ${ep.session_id}`);
  console.log(`Tool:       ${ep.tool}`);
  console.log(`Timestamp:  ${ep.ts} (${new Date(ep.ts).toLocaleString()})`);
  console.log(`LLM Ops:    ${ep.llm_ops}`);
  console.log(`Context Ops:${ep.context_ops}`);
  console.log(`Outcome:    ${ep.outcome}`);
  console.log(`Shape:      ${ep.shape}`);
  console.log(`Intent Src: ${ep.intent_source}`);
  console.log(`\nINTENT:`);
  console.log(ep.intent || "(No Intent)");
  console.log(`\nREASONING:`);
  console.log(ep.reasoning || "(No Reasoning)");
  console.log(`\nSTEPS (${steps.length}):`);

  for (const step of steps) {
    console.log(`\n  Step ${step.step_index + 1}:`);
    console.log(`    Command:     ${step.command}`);
    console.log(`    Raw:         ${step.raw_command}`);
    console.log(`    Timestamp:   ${step.ts}`);
    console.log(`    Exit Code:   ${step.exit_code ?? "N/A"}`);
    console.log(`    Error:       ${step.is_error ? "Yes" : "No"}`);
    if (step.output) {
      console.log(`    Output Head:`);
      const lines = step.output.split("\n");
      const head = lines.slice(0, 8).join("\n      ");
      console.log(`      ${head}`);
      if (lines.length > 8) {
        console.log(`      ... (${lines.length - 8} more lines)`);
      }
    } else {
      console.log(`    Output:      (none)`);
    }
  }
  console.log(`==================================================`);
}

function handleTrends(options: { tool?: string }) {
  const db = initDb(getDbPath());
  let episodes = getAllEpisodes(db);

  if (options.tool) {
    const filterTool = options.tool.toLowerCase();
    episodes = episodes.filter(ep => ep.tool === filterTool);
    console.log(`Filtering trends for tool: **${filterTool}**`);
  }

  if (episodes.length === 0) {
    console.log("No episodes found for the specified criteria. Please run 'extract' first.");
    return;
  }

  const fullEpisodes: EpisodeData[] = episodes.map(ep => {
    const dbSteps = getStepsForEpisode(db, ep.id);
    const steps: EpisodeStep[] = dbSteps.map(s => ({
      command: s.command,
      raw_command: s.raw_command,
      output: s.output || undefined,
      exit_code: s.exit_code || undefined,
      is_error: s.is_error === 1,
      ts: s.ts,
    }));
    return {
      id: ep.id,
      session_id: ep.session_id,
      intent: ep.intent,
      intent_source: ep.intent_source,
      reasoning: ep.reasoning,
      llm_ops: ep.llm_ops,
      context_ops: ep.context_ops,
      outcome: ep.outcome,
      shape: ep.shape,
      ts: ep.ts,
      tool: ep.tool,
      steps,
    };
  });

  const md = generateTrendsMarkdown(fullEpisodes);
  console.log(md);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command) {
    printUsage();
    process.exit(1);
  }

  // Parse arguments for options
  const options: {
    tool?: string;
    since?: string;
    cwd?: string;
    source?: string;
    destination?: string;
    input?: string;
    database?: string;
  } = {};
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--tool") {
      options.tool = args[i + 1];
      i++;
    } else if (args[i] === "--since") {
      options.since = args[i + 1];
      i++;
    } else if (args[i] === "--cwd") {
      options.cwd = args[i + 1];
      i++;
    } else if (args[i] === "--source") {
      options.source = args[i + 1];
      i++;
    } else if (args[i] === "--destination") {
      options.destination = args[i + 1];
      i++;
    } else if (args[i] === "--input") {
      options.input = args[i + 1];
      i++;
    } else if (args[i] === "--database") {
      options.database = args[i + 1];
      i++;
    }
  }

  switch (command) {
    case "extract":
      await handleExtract(options);
      break;
    case "episodes":
      handleEpisodes();
      break;
    case "show":
      handleShow(args[1] || "");
      break;
    case "trends":
      handleTrends(options);
      break;
    case "semantic-migrate":
      handleSemanticMigrate(options);
      break;
    case "semantic-ingest":
      await handleSemanticIngest(options);
      break;
    case "semantic-report":
      handleSemanticReport(options);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }
}

main().catch((error) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
