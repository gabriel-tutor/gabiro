#!/usr/bin/env node
import { resolve } from "node:path";
import { runStdioServer } from "./mcp/server.js";
import { DEFAULT_PORT, openInBrowser, startCanvasServer } from "./server/index.js";
import { VERSION } from "./version.js";

const USAGE = `gabiro ${VERSION}

Usage:
  gabiro mcp [--root <dir>]                       Run the MCP server over stdio
  gabiro serve [--root <dir>] [--port <n>] [--open] Run the live canvas (default port ${DEFAULT_PORT})

The project root defaults to the current directory.

Add to Claude Code:
  claude mcp add gabiro -- npx -y gabiro mcp`;

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  if (args.includes("--root") && option(args, "--root") === undefined) {
    console.error("--root needs a directory");
    process.exitCode = 1;
    return;
  }
  const root = resolve(option(args, "--root") ?? process.cwd());
  switch (command) {
    case "mcp":
      await runStdioServer(root);
      return;
    case "serve": {
      const portArg = option(args, "--port");
      const port = portArg === undefined ? DEFAULT_PORT : Number(portArg);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        console.error(`--port needs a number between 0 and 65535 (got "${portArg}")`);
        process.exitCode = 1;
        return;
      }
      const server = await startCanvasServer({ root, port });
      console.log(`gabiro canvas running at ${server.url} (project root: ${root})`);
      if (args.includes("--open")) openInBrowser(server.url);
      const stop = () => void server.close().then(() => process.exit(0));
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      return;
    }
    case "--version":
    case "-v":
      console.log(VERSION);
      return;
    default:
      console.error(USAGE);
      process.exitCode = command === undefined || command === "--help" || command === "-h" ? 0 : 1;
  }
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err);
  process.exit(1);
});
