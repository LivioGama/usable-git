import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
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

const toolResult = (envelope: V1Envelope): CallToolResult => ({
  content: [{ type: "text" as const, text: compactSummary(envelope) }],
  structuredContent: envelope as unknown as Record<string, unknown>,
  ...(envelope.ok ? {} : { isError: true }),
});

const handler = (operation: Operation) => async (input: unknown): Promise<CallToolResult> =>
  toolResult(await executeOperation(operation, input, { transport: "mcp" }));

export const createMcpServer = () => {
  const server = new McpServer({ name: "usable-git", version: "0.1.0" });
  server.registerTool("inspect", {
    description: "Inspect one local repository snapshot without mutation or network access.",
    inputSchema: inspectRequestSchema.shape,
    outputSchema: v1McpEnvelopeSchema,
    annotations: toolAnnotations.read,
  }, handler("inspect"));
  server.registerTool("review", {
    description: "Return staged and unstaged repository evidence with bounded pagination.",
    inputSchema: reviewRequestSchema.shape,
    outputSchema: v1McpEnvelopeSchema,
    annotations: toolAnnotations.read,
  }, handler("review"));
  server.registerTool("history", {
    description: "Read bounded history from an existing local ref without fetching.",
    inputSchema: historyRequestSchema.shape,
    outputSchema: v1McpEnvelopeSchema,
    annotations: toolAnnotations.read,
  }, handler("history"));
  server.registerTool("publish", {
    description: "Commit exactly the selected paths after optimistic state validation.",
    inputSchema: publishRequestSchema.shape,
    outputSchema: v1McpEnvelopeSchema,
    annotations: toolAnnotations.publish,
  }, handler("publish"));
  server.registerTool("push", {
    description: "Update exactly one configured remote branch with fast-forward or an exact lease.",
    inputSchema: pushRequestSchema.shape,
    outputSchema: v1McpEnvelopeSchema,
    annotations: toolAnnotations.push,
  }, handler("push"));
  return server;
};

export const runMcpServer = async () => {
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
};
