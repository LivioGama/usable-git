import { afterEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp.ts";
import type { TelemetryEventInput } from "../src/contracts/v1/telemetry.ts";
import {
  createRepository,
  type TestRepository,
  writeFile,
} from "./helpers/repository.ts";

const repositories: TestRepository[] = [];
afterEach(async () => Promise.all(repositories.splice(0).map(({ cleanup }) => cleanup())));

const connect = async () => {
  const server = createMcpServer();
  const client = new Client({ name: "usable-git-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { server, client };
};

describe("usable-git MCP server", () => {
  test("exposes exactly five tools with accurate safety annotations and output schemas", async () => {
    const { server, client } = await connect();
    try {
      const listed = await client.listTools();
      expect(listed.tools.map(({ name }) => name)).toEqual([
        "inspect",
        "review",
        "history",
        "publish",
        "push",
      ]);
      for (const tool of listed.tools) {
        expect(tool.inputSchema.type).toBe("object");
        expect(tool.outputSchema?.type).toBe("object");
      }
      expect(listed.tools.find(({ name }) => name === "inspect")?.annotations).toMatchObject({
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
        destructiveHint: false,
      });
      expect(listed.tools.find(({ name }) => name === "push")?.annotations).toMatchObject({
        readOnlyHint: false,
        idempotentHint: true,
        openWorldHint: true,
        destructiveHint: true,
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("returns equivalent structured and compact text output for a real call", async () => {
    const repository = await createRepository();
    repositories.push(repository);
    await writeFile(repository, "new.txt", "new\n");
    const { server, client } = await connect();
    try {
      const response = await client.callTool({
        name: "inspect",
        arguments: { repoPath: repository.path },
      });
      expect(response.structuredContent).toMatchObject({
        version: "v1",
        ok: true,
        operation: "inspect",
        transport: "mcp",
      });
      expect(response.content).toEqual([
        expect.objectContaining({ type: "text", text: expect.stringContaining("inspect: ok") }),
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("attributes telemetry to the connected client implementation", async () => {
    const repository = await createRepository();
    repositories.push(repository);
    const events: TelemetryEventInput[] = [];
    const server = createMcpServer({
      telemetrySink: {
        emit: async (event) => {
          events.push(event);
          return { written: false, reason: "disabled" };
        },
      },
    });
    const client = new Client({ name: "codex-mcp", version: "0.114.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      await client.callTool({
        name: "inspect",
        arguments: { repoPath: repository.path },
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        client: "codex",
        transport: "mcp",
        components: { client: "0.114.0" },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
