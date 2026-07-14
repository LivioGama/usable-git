import { UnifiedEvent, UnifiedAssistantEvent, UnifiedToolEvent } from "./claude";
import { Database } from "bun:sqlite";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";

export function getDevinDbPath(): string {
  return path.join(os.homedir(), ".local", "share", "devin", "cli", "sessions.db");
}

export function findDevinSessions(sinceDate: Date | null, overrideDbPath?: string): { filePath: string; sessionId: string; mtimeMs: number; workingDirectory: string }[] {
  const dbPath = overrideDbPath || getDevinDbPath();
  if (!fs.existsSync(dbPath)) return [];

  const db = new Database(dbPath, { readonly: true });
  try {
    const query = `
      SELECT id, working_directory, last_activity_at, main_chain_id
      FROM sessions
      WHERE hidden = 0
    `;
    const rows = db.prepare(query).all() as { id: string; working_directory: string; last_activity_at: number; main_chain_id: number | null }[];
    
    return rows
      .map(row => {
        const mtimeMs = row.last_activity_at * 1000;
        return {
          filePath: `devin://sessions.db/session/${row.id}`,
          sessionId: row.id,
          mtimeMs,
          workingDirectory: row.working_directory,
        };
      })
      .filter(item => {
        if (sinceDate && item.mtimeMs < sinceDate.getTime()) {
          return false;
        }
        return true;
      });
  } catch (e) {
    return [];
  } finally {
    db.close();
  }
}

export async function* streamDevinLog(sessionId: string, overrideDbPath?: string): AsyncGenerator<UnifiedEvent> {
  const dbPath = overrideDbPath || getDevinDbPath();
  if (!fs.existsSync(dbPath)) return;

  const db = new Database(dbPath, { readonly: true });
  let rows: any[] = [];

  try {
    const sessRow = db.prepare("SELECT main_chain_id FROM sessions WHERE id = ?").get(sessionId) as { main_chain_id: number | null } | null;
    if (!sessRow || sessRow.main_chain_id === null) return;

    const cteQuery = `
      WITH RECURSIVE chain(session_id, node_id, parent_node_id, chat_message, created_at) AS (
        SELECT session_id, node_id, parent_node_id, chat_message, created_at
        FROM message_nodes
        WHERE session_id = ? AND node_id = ?
        UNION ALL
        SELECT m.session_id, m.node_id, m.parent_node_id, m.chat_message, m.created_at
        FROM message_nodes m
        JOIN chain c ON m.session_id = c.session_id AND m.node_id = c.parent_node_id
      )
      SELECT chat_message, created_at
      FROM chain
      ORDER BY created_at ASC
    `;
    
    rows = db.prepare(cteQuery).all(sessionId, sessRow.main_chain_id);
  } catch (e) {
    db.close();
    return;
  }
  db.close();

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

  for (const row of rows) {
    const ts = new Date(row.created_at * 1000).toISOString();
    try {
      const obj = JSON.parse(row.chat_message);
      const role = obj.role;

      if (role === "user") {
        yield* flushAll();
        yield {
          role: "user",
          text: obj.content || "",
          ts,
        };
      } else if (role === "assistant") {
        yield* flushTool();
        if (!currentAssistant) {
          currentAssistant = {
            role: "assistant",
            thinking: [],
            text: [],
            tool_calls: [],
            ts,
          };
        }

        const thinkingVal = obj.thinking?.thinking;
        if (thinkingVal) {
          currentAssistant.thinking.push(thinkingVal);
        }

        if (obj.content) {
          currentAssistant.text.push(obj.content);
        }

        if (Array.isArray(obj.tool_calls)) {
          for (const tc of obj.tool_calls) {
            const name = tc.name;
            if (name === "exec" || name === "exec_command" || name === "run_command") {
              let args = tc.arguments || {};
              if (typeof args === "string") {
                try {
                  args = JSON.parse(args);
                } catch {
                  args = {};
                }
              }
              const cmd = args.cmd || args.command || "";
              if (cmd) {
                currentAssistant.tool_calls.push({
                  name: "Bash",
                  input: { command: cmd },
                  id: tc.id || "",
                });
              }
            }
          }
        }
      } else if (role === "tool") {
        yield* flushAssistant();
        if (!currentTool) {
          currentTool = {
            role: "tool",
            tool_results: [],
            ts,
          };
        }

        let isError = false;
        const ext = obj.metadata?.extensions || {};
        const resultMeta = ext["chisel/tool_result_meta"] || {};
        if (resultMeta.success === false) {
          isError = true;
        }
        const exitMatch = /Process exited with code (\d+)/i.exec(obj.content || "");
        if (exitMatch && exitMatch[1] && exitMatch[1] !== "0") {
          isError = true;
        }

        currentTool.tool_results.push({
          tool_use_id: obj.tool_call_id || "",
          content: obj.content || "",
          is_error: isError,
        });
      }
    } catch (e) {
      // Ignore parse errors
    }
  }

  yield* flushAll();
}
