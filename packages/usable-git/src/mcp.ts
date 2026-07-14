import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { z } from "zod";
import {
  historyRequestSchema,
  inspectRequestSchema,
  reviewRequestSchema,
  v1McpEnvelopeSchema,
  type V1Envelope,
} from "./contracts/v1.ts";
import { publishRequestSchema } from "./contracts/v1/publish.ts";
import { pushRequestSchema } from "./contracts/v1/push.ts";
import { executeOperation, type Operation } from "./service.ts";

const toolAnnotations = {
  read: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  publish: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  push: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
} as const;

const compactSummary = (envelope: V1Envelope) =>
  envelope.ok
    ? `${envelope.operation}: ok (${envelope.gitSubprocessCount} git subprocesses)`
    : `${envelope.operation}: ${envelope.error.code} — ${envelope.error.message}`;

const toolResult = (envelope: V1Envelope) => ({
  content: [{ type: "text" as const, text: compactSummary(envelope) }],
  structuredContent: envelope as unknown as Record<string, unknown>,
  ...(envelope.ok ? {} : { isError: true }),
});

const register = <Schema extends z.ZodType>(
  server: McpServer,
  operation: Operation,
  description: string,
  inputSchema: Schema,
  annotations: typeof toolAnnotations.read | typeof toolAnnotations.publish | typeof toolAnnotations.push,
) => {
  server.registerTool(
    operation,
    {
      description,
      inputSchema,
      outputSchema: v1McpEnvelopeSchema,
      annotations,
    },
    async (input) => toolResult(await executeOperation(operation, input, { transport: "mcp" })),
  );
};

export const createMcpServer = () => {
  const server = new McpServer({ name: "usable-git", version: "0.1.0" });
  register(server, "inspect", "Inspect one local repository snapshot without mutation or network access.", inspectRequestSchema, toolAnnotations.read);
  register(server, "review", "Return staged and unstaged repository evidence with bounded pagination.", reviewRequestSchema, toolAnnotations.read);
  register(server, "history", "Read bounded history from an existing local ref without fetching.", historyRequestSchema, toolAnnotations.read);
  register(server, "publish", "Commit exactly the selected paths after optimistic state validation.", publishRequestSchema, toolAnnotations.publish);
  register(server, "push", "Update exactly one configured remote branch with fast-forward or an exact lease.", pushRequestSchema, toolAnnotations.push);
  return server;
};

export const runMcpServer = async () => {
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
};
