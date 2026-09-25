import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { expect, it } from "vitest";
import { tempRoot } from "../helpers.js";

const cli = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

it.skipIf(!existsSync(cli))("runs the built CLI as a stdio MCP server (run `npm run build` first)", async () => {
  const root = await tempRoot();
  const client = new Client({ name: "e2e", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp", "--root", root] }));
  try {
    const r = (await client.callTool({
      name: "gabiro_create_board",
      arguments: { title: "Login", kind: "sequence", ops: [
        { op: "add_node", id: "user", type: "participant", label: "User", order: 1 },
        { op: "add_node", id: "auth", type: "participant", label: "Auth", order: 2 },
        { op: "add_edge", from: "user", to: "auth", type: "message", label: "login", order: 1 },
      ] },
    })) as CallToolResult;
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ boardId: "login", revision: 1, nodes: 2 });
  } finally {
    await client.close();
  }
}, 20_000);
