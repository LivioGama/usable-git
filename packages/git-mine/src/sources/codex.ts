import { createInterface } from "readline";
import { createReadStream } from "fs";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { UnifiedEvent, UnifiedAssistantEvent, UnifiedUserEvent, UnifiedToolEvent } from "./claude";

export let skippedCustomToolsCount = 0;

/**
 * Parses a Codex log file and returns its session ID and CWD if found.
 */
export async function getCodexFileMeta(filePath: string): Promise<{ sessionId: string; cwd: string } | null> {
  if (!fs.existsSync(filePath)) return null;
  const fileStream = createReadStream(filePath);
  const rl = createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.includes('"type":"session_meta"')) {
        const obj = JSON.parse(trimmed);
        if (obj.type === "session_meta" && obj.payload) {
          return {
            sessionId: obj.payload.id || "",
            cwd: obj.payload.cwd || "",
          };
        }
      }
    }
  } catch (e) {
    // Ignore issues parsing lines for meta
  } finally {
    rl.close();
  }
  return null;
}

/**
 * Extracts and joins text from content blocks.
 */
function extractMessageText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block: any) => {
        if (typeof block === "string") return block;
        if (block && typeof block === "object") {
          return block.text || block.input_text || block.output_text || "";
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/**
 * Streams a Codex jsonl file, grouping consecutive assistant and tool events.
 */
export async function* streamCodexLog(filePath: string): AsyncGenerator<UnifiedEvent> {
  const fileStream = createReadStream(filePath);
  const rl = createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  let currentAssistant: UnifiedAssistantEvent | null = null;
  let currentTool: UnifiedToolEvent | null = null;

  async function* flushAssistant() {
    if (currentAssistant) {
      yield currentAssistant;
      currentAssistant = null;
    }
  }

  async function* flushTool() {
    if (currentTool) {
      yield currentTool;
      currentTool = null;
    }
  }

  async function* flushAll() {
    yield* flushAssistant();
    yield* flushTool();
  }

  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Pre-filter to avoid unnecessary JSON parsing
      const lower = trimmed.toLowerCase();
      const hasGit = lower.includes("git");
      const isUser = trimmed.includes('"role":"user"');
      const isAssistant = trimmed.includes('"role":"assistant"');
      const isReasoning = trimmed.includes('"type":"reasoning"');
      const isFunctionCall = trimmed.includes('"type":"function_call"') || trimmed.includes('"type":"function_call_output"');
      const isCustomTool = trimmed.includes('"type":"custom_tool_call"') || trimmed.includes('"type":"custom_tool_call_output"');

      if (!hasGit && !isUser && !isAssistant && !isReasoning && !isFunctionCall && !isCustomTool) {
        continue;
      }

      try {
        const obj = JSON.parse(trimmed.replace(/\u0000/g, ""));
        const ts = obj.timestamp || "";

        if (obj.type === "response_item" && obj.payload) {
          const payload = obj.payload;

          if (payload.type === "message") {
            const role = payload.role;

            if (role === "user") {
              yield* flushAll();
              const text = extractMessageText(payload.content);
              yield {
                role: "user",
                text,
                ts,
              };
            } else if (role === "assistant") {
              yield* flushTool();
              const text = extractMessageText(payload.content);
              if (!currentAssistant) {
                currentAssistant = {
                  role: "assistant",
                  thinking: [],
                  text: [],
                  tool_calls: [],
                  ts,
                };
              }
              if (text) {
                currentAssistant.text.push(text);
              }
            }
            // Drop developer/system roles (as decided & documented: strictly meta/configurations)
          } else if (payload.type === "reasoning") {
            yield* flushTool();
            const content = payload.content || "";
            const summary = Array.isArray(payload.summary) ? payload.summary.join("\n") : (payload.summary || "");
            const thinkingText = [content, summary].filter(Boolean).join("\n");

            if (thinkingText) {
              if (!currentAssistant) {
                currentAssistant = {
                  role: "assistant",
                  thinking: [],
                  text: [],
                  tool_calls: [],
                  ts,
                };
              }
              currentAssistant.thinking.push(thinkingText);
            }
          } else if (payload.type === "function_call") {
            if (payload.name === "exec_command") {
              yield* flushTool();
              let argsStr = payload.arguments || "{}";
              if (typeof argsStr === "string") {
                argsStr = argsStr.replace(/\u0000/g, "").trim();
              }
              const args = typeof argsStr === "string" ? JSON.parse(argsStr) : argsStr;
              const cmd = args.cmd || "";
              if (cmd) {
                if (!currentAssistant) {
                  currentAssistant = {
                    role: "assistant",
                    thinking: [],
                    text: [],
                    tool_calls: [],
                    ts,
                  };
                }
                currentAssistant.tool_calls.push({
                  name: "Bash", // map exec_command to Bash
                  input: { command: cmd },
                  id: payload.call_id || "",
                });
              }
            }
          } else if (payload.type === "function_call_output") {
            yield* flushAssistant();
            const output = payload.output || "";
            let exitCode: number | null = null;
            const exitMatch = /Process exited with code (\d+)/.exec(output);
            if (exitMatch) {
              exitCode = parseInt(exitMatch[1], 10);
            }

            const isError = exitCode !== null ? (exitCode !== 0) : (output.includes("BLOCKED") || output.includes("error"));

            // Strip the header wrapper
            let cleanOutput = output;
            const outputIndex = cleanOutput.indexOf("Output:\n---\n");
            if (outputIndex !== -1) {
              cleanOutput = cleanOutput.substring(outputIndex + "Output:\n---\n".length);
            } else {
              const plainOutputIndex = cleanOutput.indexOf("Output:\n");
              if (plainOutputIndex !== -1) {
                cleanOutput = cleanOutput.substring(plainOutputIndex + "Output:\n".length);
              }
            }

            if (!currentTool) {
              currentTool = {
                role: "tool",
                tool_results: [],
                ts,
              };
            }
            currentTool.tool_results.push({
              tool_use_id: payload.call_id || "",
              content: cleanOutput.trim(),
              is_error: isError,
            });
          } else if (payload.type === "custom_tool_call" || payload.type === "custom_tool_call_output") {
            // Count custom tools that are not running shell commands
            skippedCustomToolsCount++;
          }
        }
      } catch (e) {
        // Ignore JSON parsing/format errors for malformed lines
      }
    }

    yield* flushAll();
  } finally {
    rl.close();
  }
}

/**
 * Finds all Codex jsonl files in sessions/ and archived_sessions/, applying date pruning if sinceDate is specified.
 */
export function findCodexFiles(sinceDate: Date | null): string[] {
  const sessionsDir = path.join(os.homedir(), ".codex", "sessions");
  const archivedDir = path.join(os.homedir(), ".codex", "archived_sessions");
  const files: string[] = [];

  // 1. Scan sessions/ with date pruning
  if (fs.existsSync(sessionsDir)) {
    files.push(...findCodexJsonlFiles(sessionsDir, sinceDate));
  }

  // 2. Scan archived_sessions/ with filename date pruning
  if (fs.existsSync(archivedDir)) {
    const items = fs.readdirSync(archivedDir, { withFileTypes: true });
    for (const item of items) {
      if (item.isFile() && item.name.endsWith(".jsonl")) {
        const match = /^rollout-(\d{4})-(\d{2})-(\d{2})T/.exec(item.name);
        if (match && sinceDate) {
          const year = parseInt(match[1], 10);
          const month = parseInt(match[2], 10);
          const day = parseInt(match[3], 10);
          const endOfDay = new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999));
          if (sinceDate > endOfDay) {
            continue;
          }
        }
        files.push(path.join(archivedDir, item.name));
      }
    }
  }

  return files;
}

function findCodexJsonlFiles(dir: string, sinceDate: Date | null): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  if (sinceDate) {
    const relative = path.relative(path.join(os.homedir(), ".codex", "sessions"), dir);
    if (relative && relative !== "..") {
      const parts = relative.split(path.sep);
      if (parts.length === 1) {
        const year = parseInt(parts[0], 10);
        if (!isNaN(year)) {
          const endOfYear = new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999));
          if (sinceDate > endOfYear) return [];
        }
      } else if (parts.length === 2) {
        const year = parseInt(parts[0], 10);
        const month = parseInt(parts[1], 10);
        if (!isNaN(year) && !isNaN(month)) {
          const endOfMonth = new Date(Date.UTC(year, month - 1, 31, 23, 59, 59, 999));
          if (sinceDate > endOfMonth) return [];
        }
      } else if (parts.length === 3) {
        const year = parseInt(parts[0], 10);
        const month = parseInt(parts[1], 10);
        const day = parseInt(parts[2], 10);
        if (!isNaN(year) && !isNaN(month) && !isNaN(day)) {
          const endOfDay = new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999));
          if (sinceDate > endOfDay) return [];
        }
      }
    }
  }

  const items = fs.readdirSync(dir, { withFileTypes: true });
  for (const item of items) {
    const fullPath = path.join(dir, item.name);
    if (item.isDirectory()) {
      results.push(...findCodexJsonlFiles(fullPath, sinceDate));
    } else if (item.isFile() && item.name.endsWith(".jsonl")) {
      results.push(fullPath);
    }
  }
  return results;
}
