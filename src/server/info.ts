import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../store/index.js";
import type { HealthResponse } from "./protocol.js";

/** Contents of `.gabiro/server.json`, written by a running canvas server. */
export interface ServerInfo {
  pid: number;
  port: number;
  url: string;
  root: string;
}

export const serverInfoPath = (root: string) => join(root, ".gabiro", "server.json");

export async function writeServerInfo(info: ServerInfo): Promise<void> {
  await writeFileAtomic(serverInfoPath(info.root), JSON.stringify(info, null, 2) + "\n");
}

/** Returns the recorded server, or undefined if the file is missing or unreadable. */
export async function readServerInfo(root: string): Promise<ServerInfo | undefined> {
  try {
    const info = JSON.parse(await readFile(serverInfoPath(root), "utf8")) as ServerInfo;
    return typeof info.url === "string" && typeof info.pid === "number" ? info : undefined;
  } catch {
    return undefined;
  }
}

/** Removes server.json, but only if it still describes this process (a newer server may have replaced it). */
export async function clearServerInfo(root: string, pid = process.pid): Promise<void> {
  const info = await readServerInfo(root);
  if (info?.pid === pid) await rm(serverInfoPath(root), { force: true });
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** True if a gabiro canvas server for exactly this project root answers at `url`. */
export async function isHealthy(url: string, root: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) });
    if (!res.ok) return false;
    const body = (await res.json()) as Partial<HealthResponse>;
    return body.ok === true && body.root === root;
  } catch {
    return false;
  }
}
