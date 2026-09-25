import { describe, expect, it } from "vitest";
import { createBoard, slugify } from "../../src/core/index.js";

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    expect(slugify("Checkout – Architecture!")).toBe("checkout-architecture");
  });
  it("rejects text with no usable characters", () => {
    expect(() => slugify("!!!")).toThrow(/explicit id/);
  });
});

describe("createBoard", () => {
  it("creates an empty board at revision 1 with a slug id", () => {
    const b = createBoard({ title: "Checkout API", kind: "architecture", now: "2026-01-01T00:00:00.000Z" });
    expect(b).toEqual({
      id: "checkout-api",
      title: "Checkout API",
      kind: "architecture",
      revision: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      layout: { direction: "LR" },
      groups: [],
      nodes: [],
      edges: [],
    });
  });
  it("defaults flowcharts to top-to-bottom", () => {
    expect(createBoard({ title: "Signup", kind: "flowchart" }).layout.direction).toBe("TB");
  });
});
