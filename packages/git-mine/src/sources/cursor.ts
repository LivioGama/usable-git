import { UnifiedEvent, UnifiedAssistantEvent } from "./claude";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { createInterface } from "readline";

export function findCursorFiles(sinceDate: Date | null): string[] {
  const baseDir = path.join(os.homedir(), ".cursor", "projects");
  const results: string[] = [];
  if (!fs.existsSync(baseDir)) return results;

  function traverse(dir: string) {
    const items = fs.readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
      const fullPath = path.join(dir, item.name);
      if (item.isDirectory()) {
        traverse(fullPath);
      } else if (item.isFile() && item.name.endsWith(".jsonl")) {
        // Apply date pruning if specified
        if (sinceDate) {
          const stat = fs.statSync(fullPath);
          if (stat.mtimeMs < sinceDate.getTime()) {
            continue;
          }
        }
        results.push(fullPath);
      }
    }
  }

  traverse(baseDir);
  return results;
}

export function stripQueryWrappers(text: string): string {
  let cleaned = text;
  cleaned = cleaned.replace(/<user_query>([\s\S]*?)<\/user_query>/gi, "$1");
  cleaned = cleaned.replace(/<timestamp>([\s\S]*?)<\/timestamp>/gi, "");
  return cleaned.trim();
}

export async function* streamCursorLog(filePath: string): AsyncGenerator<UnifiedEvent> {
  if (!fs.existsSync(filePath)) return;

  const stat = fs.statSync(filePath);
  const fileStream = fs.createReadStream(filePath);
  const rl = createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  let currentAssistant: UnifiedAssistantEvent | null = null;
  let lineIdx = 0;

  async function* flushAssistant() {
    if (currentAssistant) {
      yield currentAssistant;
      currentAssistant = null;
    }
  }

  try {
    for await (const line of rl) {
      lineIdx++;
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Pre-filter: only process lines containing role or message details
      if (!trimmed.includes('"role"') && !trimmed.includes('"message"')) {
        continue;
      }

      try {
        const obj = JSON.parse(trimmed);
        const role = obj.role;
        if (!role) continue;

        if (role === "user") {
          yield* flushAssistant();

          let text = "";
          if (obj.message && Array.isArray(obj.message.content)) {
            const textBlock = obj.message.content.find((c: any) => c.type === "text");
            if (textBlock && textBlock.text) {
              text = textBlock.text;
            }
          }

          // Parse timestamp from <timestamp> tag if present, else fallback to file mtime
          let ts = "";
          const tsMatch = /<timestamp>([\s\S]*?)<\/timestamp>/i.exec(text);
          if (tsMatch && tsMatch[1]) {
            const rawTs = tsMatch[1].trim();
            const d = new Date(rawTs);
            if (!isNaN(d.getTime())) {
              ts = d.toISOString();
            }
          }
          if (!ts) {
            ts = stat.mtime.toISOString();
          }

          const cleanedText = stripQueryWrappers(text);
          yield {
            role: "user",
            text: cleanedText,
            ts,
          };
        } else if (role === "assistant") {
          // Initialize currentAssistant if needed
          if (!currentAssistant) {
            currentAssistant = {
              role: "assistant",
              thinking: [],
              text: [],
              tool_calls: [],
              ts: stat.mtime.toISOString(), // Fallback timestamp
            };
          }

          if (obj.message && Array.isArray(obj.message.content)) {
            let blockIdx = 0;
            for (const block of obj.message.content) {
              blockIdx++;
              if (block.type === "text" && block.text) {
                currentAssistant.text.push(block.text);
              } else if (block.type === "tool_use") {
                const toolName = block.name;
                const input = block.input || {};
                if (toolName === "Shell" && typeof input.command === "string") {
                  currentAssistant.tool_calls.push({
                    name: "Bash", // Map "Shell" to "Bash"
                    input: { command: input.command },
                    id: `cursor_tool_${lineIdx}_${blockIdx}`,
                  });
                }
              }
            }
          }
        }
      } catch (e) {
        // Ignore syntax errors in malformed lines
      }
    }
    yield* flushAssistant();
  } catch (e) {
    // Ignore read errors
  } finally {
    rl.close();
  }
}
