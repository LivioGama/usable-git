import { createInterface } from "readline";
import { createReadStream } from "fs";

export interface UnifiedAssistantEvent {
  role: "assistant";
  thinking: string[];
  text: string[];
  tool_calls: {
    name: string;
    input: any;
    id: string;
  }[];
  ts: string;
}

export interface UnifiedUserEvent {
  role: "user";
  text: string;
  ts: string;
}

export interface UnifiedToolEvent {
  role: "tool";
  tool_results: {
    tool_use_id: string;
    content: string;
    is_error: boolean;
  }[];
  ts: string;
}

export type UnifiedEvent = UnifiedAssistantEvent | UnifiedUserEvent | UnifiedToolEvent;

export async function* streamClaudeLog(filePath: string): AsyncGenerator<UnifiedEvent> {
  const fileStream = createReadStream(filePath);
  const rl = createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Fast substring pre-filter
    const hasGit = trimmed.toLowerCase().includes("git");
    const isUser = trimmed.includes('"type":"user"');
    const isAssistant = trimmed.includes('"type":"assistant"');

    if (!hasGit && !isUser && !isAssistant) {
      continue;
    }

    try {
      const obj = JSON.parse(trimmed);
      const ts = obj.timestamp || "";

      if (obj.type === "user" && obj.message?.role === "user") {
        const content = obj.message.content;
        if (typeof content === "string") {
          // Check if this is a tool result or normal text
          yield {
            role: "user",
            text: content,
            ts,
          };
        } else if (Array.isArray(content)) {
          const toolResults: UnifiedToolEvent["tool_results"] = [];
          let textParts = "";

          for (const part of content) {
            if (part.type === "text" && part.text) {
              textParts += (textParts ? "\n" : "") + part.text;
            } else if (part.type === "tool_result") {
              const stdout = obj.toolUseResult?.stdout || part.content || "";
              const stderr = obj.toolUseResult?.stderr || "";
              const exitCode = obj.toolUseResult?.exitCode;
              const isError = part.is_error || (exitCode !== undefined && exitCode !== 0) || false;

              toolResults.push({
                tool_use_id: part.tool_use_id,
                content: (stdout + (stderr ? "\n" + stderr : "")).trim(),
                is_error: isError,
              });
            }
          }

          if (toolResults.length > 0) {
            yield {
              role: "tool",
              tool_results: toolResults,
              ts,
            };
          } else if (textParts) {
            yield {
              role: "user",
              text: textParts,
              ts,
            };
          }
        }
      } else if (obj.type === "assistant" && obj.message?.role === "assistant") {
        const content = obj.message.content;
        if (Array.isArray(content)) {
          const thinking: string[] = [];
          const text: string[] = [];
          const tool_calls: UnifiedAssistantEvent["tool_calls"] = [];

          for (const part of content) {
            if (part.type === "thinking" && part.thinking) {
              thinking.push(part.thinking);
            } else if (part.type === "text" && part.text) {
              text.push(part.text);
            } else if (part.type === "tool_use") {
              tool_calls.push({
                name: part.name,
                input: part.input,
                id: part.id,
              });
            }
          }

          yield {
            role: "assistant",
            thinking,
            text,
            tool_calls,
            ts,
          };
        }
      }
    } catch (e) {
      // Ignore JSON parsing/format errors for malformed lines
    }
  }
}
