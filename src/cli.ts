#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { runStdioServer } from "./mcp/server.js";
import { DEFAULT_PORT, openInBrowser, startCanvasServer } from "./server/index.js";
import { VERSION } from "./version.js";

const USAGE = `gabiro ${VERSION}

Usage:
  gabiro mcp [--root <dir>]                       Run the MCP server over stdio
  gabiro serve [--root <dir>] [--port <n>] [--open] [--idle-exit <minutes>]
                                                  Run the live canvas (default port ${DEFAULT_PORT});
                                                  --idle-exit stops it after that long with no open canvas

The project root defaults to the current directory.

Add to Claude Code:
  claude mcp add gabiro -- npx -y gabiro mcp`;

/** setTimeout overflows above 2^31-1 ms (about 35,791 minutes). */
const MAX_IDLE_MINUTES = 35_000;

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
  const requested = resolve(option(args, "--root") ?? process.cwd());
  let root: string;
  try {
    root = realpathSync(requested);
  } catch {
    console.error(`gabiro: the project root ${requested} doesn't exist`);
    process.exitCode = 1;
    return;
  }
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
      const idleArg = option(args, "--idle-exit");
      const idleMinutes = idleArg === undefined ? undefined : Number(idleArg);
      if (args.includes("--idle-exit") && !(idleMinutes !== undefined && idleMinutes > 0 && idleMinutes <= MAX_IDLE_MINUTES)) {
        console.error(`--idle-exit needs a number of minutes greater than 0 and at most ${MAX_IDLE_MINUTES} (got "${idleArg}")`);
        process.exitCode = 1;
        return;
      }
      // Last line of defence: a stray rejection must not take the canvas down.
      process.on("unhandledRejection", (err) => console.error("gabiro canvas:", err));
      let stopping = false;
      const stop = () => {
        if (stopping) return;
        stopping = true;
        void server.close().then(() => process.exit(0));
      };
      const server = await startCanvasServer({
        root,
        port,
        idleExitMs: idleMinutes === undefined ? undefined : idleMinutes * 60_000,
        onIdle: () => {
          console.log("gabiro canvas: no open canvas, stopping (--idle-exit)");
          stop();
        },
      });
      console.log(`gabiro canvas running at ${server.url} (project root: ${root})`);
      if (args.includes("--open")) openInBrowser(server.url);
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
