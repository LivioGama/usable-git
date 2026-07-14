import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp.ts";

const expectedResultField = {
  inspect: "changes",
  review: "items",
  history: "commits",
  publish: "committedPaths",
  push: "confirmedAfterFailure",
} as const;

describe("MCP operation-specific result contracts", () => {
  test("publishes a distinct strict result schema for each of exactly five tools", async () => {
    const server = createMcpServer();
    const client = new Client({ name: "schema-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map(({ name }) => name)).toEqual(Object.keys(expectedResultField));

      for (const tool of listed.tools) {
        const schema = tool.outputSchema as {
          properties?: Record<string, unknown>;
        };
        expect(schema.properties?.operation).toMatchObject({ const: tool.name });
        expect(JSON.stringify(schema.properties?.result)).toContain(
          `\"${expectedResultField[tool.name as keyof typeof expectedResultField]}\"`,
        );
      }
    } finally {
      await client.close();
      await server.close();
    }
  });
});
