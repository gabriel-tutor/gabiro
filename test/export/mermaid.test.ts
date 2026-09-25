import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { KINDS } from "../../src/core/index.js";
import { toMermaid } from "../../src/export/index.js";
import { FIXTURES } from "../fixtures/boards.js";

const golden = (kind: string) => readFileSync(new URL(`./golden/${kind}.mmd`, import.meta.url), "utf8");

describe("toMermaid", () => {
  for (const kind of KINDS.filter((k) => k !== "freeform")) {
    it(`matches the golden file for ${kind}`, () => {
      expect(toMermaid(FIXTURES[kind]) + "\n").toBe(golden(kind));
    });
  }

  it("returns null for freeform boards", () => {
    expect(toMermaid(FIXTURES.freeform)).toBeNull();
  });

  it("is independent of node insertion order", () => {
    const reversed = { ...FIXTURES.architecture, nodes: [...FIXTURES.architecture.nodes].reverse() };
    expect(toMermaid(reversed)).toBe(toMermaid(FIXTURES.architecture));
  });
});
