import { UnifiedEvent, UnifiedAssistantEvent, UnifiedToolEvent } from "./claude";
import { Database } from "bun:sqlite";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";

export let skippedOpenCodeToolsCount = 0;

export function getOpenCodeDbPath(): string {
  return path.join(os.homedir(), ".local", "share", "opencode", "opencode.db");
}

export function findOpenCodeSessions(sinceDate: Date | null, overrideDbPath?: string): { filePath: string; sessionId: string; mtimeMs: number; workingDirectory: string }[] {
  const dbPath = overrideDbPath || getOpenCodeDbPath();
  if (!fs.existsSync(dbPath)) return [];

  const db = new Database(dbPath, { readonly: true });
  try {
    const query = `
      SELECT id, slug, directory, time_updated
      FROM session
    `;
    const rows = db.prepare(query).all() as { id: string; slug: string; directory: string; time_updated: number }[];
    
    return rows
      .map(row => {
        return {
          filePath: `opencode://opencode.db/session/${row.id}`,
          sessionId: row.id,
          mtimeMs: row.time_updated,
          workingDirectory: row.directory,
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

export async function* streamOpenCodeLog(sessionId: string, overrideDbPath?: string): AsyncGenerator<UnifiedEvent> {
  const dbPath = overrideDbPath || getOpenCodeDbPath();
  if (!fs.existsSync(dbPath)) return;

  const db = new Database(dbPath, { readonly: true });
  let msgRows: any[] = [];

  try {
    // Get all messages for the session sorted chronologically
    const msgQuery = `
      SELECT id, data, time_created
      FROM message
      WHERE session_id = ?
      ORDER BY time_created ASC
    `;
    msgRows = db.prepare(msgQuery).all(sessionId) as { id: string; data: string; time_created: number }[];
  } catch (e) {
    db.close();
    return;
  }

  for (const msgRow of msgRows) {
    const ts = new Date(msgRow.time_created).toISOString();
    try {
      const msgData = JSON.parse(msgRow.data);
      const role = msgData.role;
      if (!role) continue;

      // Get parts for this message
      const partQuery = `
        SELECT data, time_created
        FROM part
        WHERE message_id = ?
        ORDER BY time_created ASC, id ASC
      `;
      const parts = db.prepare(partQuery).all(msgRow.id) as { data: string; time_created: number }[];

      if (role === "user") {
        let textContent = "";
        for (const p of parts) {
          try {
            const pData = JSON.parse(p.data);
            if (pData.type === "text" && pData.text) {
              textContent += (textContent ? "\n" : "") + pData.text;
            }
          } catch {}
        }
        yield {
          role: "user",
          text: textContent,
          ts,
        };
      } else if (role === "assistant") {
        const thinking: string[] = [];
        const text: string[] = [];
        const toolCalls: { name: string; input: any; id: string }[] = [];
        const toolResults: { tool_use_id: string; content: string; is_error: boolean }[] = [];

        for (const p of parts) {
          try {
            const pData = JSON.parse(p.data);
            if (pData.type === "reasoning" && pData.text) {
              thinking.push(pData.text);
            } else if (pData.type === "text" && pData.text) {
              text.push(pData.text);
            } else if (pData.type === "tool") {
              const toolName = pData.tool;
              const callId = pData.callID || "";
              const state = pData.state || {};
              const input = state.input || {};
              const metadata = state.metadata || {};

              if (toolName === "bash" && typeof input.command === "string") {
                toolCalls.push({
                  name: "Bash",
                  input: { command: input.command },
                  id: callId,
                });

                const isError = typeof metadata.exit === "number" && metadata.exit !== 0;
                toolResults.push({
                  tool_use_id: callId,
                  content: state.output || "",
                  is_error: isError,
                });
              } else {
                skippedOpenCodeToolsCount++;
              }
            } else if (pData.type === "patch") {
              skippedOpenCodeToolsCount++;
            }
          } catch {}
        }

        // Yield assistant event if we gathered text, thinking, or tool calls
        if (text.length > 0 || thinking.length > 0 || toolCalls.length > 0) {
          yield {
            role: "assistant",
            thinking,
            text,
            tool_calls: toolCalls,
            ts,
          };

          // If we had tool calls, immediately yield matching tool results event
          if (toolResults.length > 0) {
            yield {
              role: "tool",
              tool_results: toolResults,
              ts,
            };
          }
        }
      }
    } catch (e) {
      // Ignore parse errors
    }
  }

  db.close();
}
