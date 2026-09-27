/** Quotes a shell word only when it needs it (POSIX single quotes). */
export function shellQuote(word: string): string {
  return /^[A-Za-z0-9_\/.:=@%+,-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/** The command that registers the gabiro MCP server with Claude Code. */
export function claudeCodeCommand(command: string[]): string {
  return ["claude", "mcp", "add", "gabiro", "--", ...command].map(shellQuote).join(" ");
}

/**
 * The `mcpServers` entry for Claude Desktop, Cursor and similar clients. These don't start the
 * server in the project folder, so it passes --root with a placeholder to replace.
 */
export function mcpServersJson(command: string[]): string {
  const [cmd, ...args] = command;
  const config = { mcpServers: { gabiro: { command: cmd, args: [...args, "--root", "/path/to/your/project"] } } };
  return JSON.stringify(config, null, 2);
}
