import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BoardService } from "../service/index.js";
import { VERSION } from "../version.js";
import { SERVER_INSTRUCTIONS } from "./help.js";
import { defaultCanvas, registerTools, type CanvasAccess } from "./tools.js";

export function createMcpServer(root: string, canvas: CanvasAccess = defaultCanvas): McpServer {
  const server = new McpServer({ name: "gabiro", version: VERSION }, { instructions: SERVER_INSTRUCTIONS });
  registerTools(server, new BoardService(root), canvas);
  return server;
}

export async function runStdioServer(root: string): Promise<void> {
  const server = createMcpServer(root);
  await server.connect(new StdioServerTransport());
  // stdout carries the protocol; logs go to stderr.
  console.error(`gabiro MCP server ${VERSION} running on stdio (project root: ${root})`);
}
