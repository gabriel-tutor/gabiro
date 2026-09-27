import { describe, expect, it } from "vitest";
import { claudeCodeCommand, mcpServersJson, shellQuote } from "../../desktop/src/agent-setup.js";

const BIN = "/Applications/Gabiro.app/Contents/Resources/bin/gabiro";

describe("agent setup snippets", () => {
  it("quotes only the words that need it", () => {
    expect(shellQuote(BIN)).toBe(BIN);
    expect(shellQuote("/Users/me/My Apps/Gabiro.app")).toBe("'/Users/me/My Apps/Gabiro.app'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  it("builds the Claude Code command", () => {
    expect(claudeCodeCommand([BIN, "mcp"])).toBe(`claude mcp add gabiro -- ${BIN} mcp`);
    expect(claudeCodeCommand(["/Users/me/My Apps/Gabiro.app/Contents/Resources/bin/gabiro", "mcp"])).toBe(
      "claude mcp add gabiro -- '/Users/me/My Apps/Gabiro.app/Contents/Resources/bin/gabiro' mcp",
    );
  });

  it("builds the mcpServers JSON with a --root placeholder", () => {
    expect(JSON.parse(mcpServersJson([BIN, "mcp"]))).toEqual({
      mcpServers: { gabiro: { command: BIN, args: ["mcp", "--root", "/path/to/your/project"] } },
    });
  });
});
