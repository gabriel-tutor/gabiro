import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDeepLink } from "../../desktop/src/deeplink.js";
import { appLink } from "../../src/server/index.js";
import { tempRoot } from "../helpers.js";

describe("parseDeepLink", () => {
  it("parses gabiro://start", () => {
    expect(parseDeepLink("gabiro://start")).toEqual({ ok: true, link: { action: "start" } });
  });

  it("parses an open link with and without a board", async () => {
    const root = await tempRoot();
    expect(parseDeepLink(appLink(root))).toEqual({ ok: true, link: { action: "open", root } });
    expect(parseDeepLink(appLink(root, "checkout"))).toEqual({ ok: true, link: { action: "open", root, boardId: "checkout" } });
    expect(parseDeepLink(`gabiro://open?root=${encodeURIComponent(root + "/")}`)).toEqual({ ok: true, link: { action: "open", root } });
  });

  it("round-trips roots with spaces and unicode", async () => {
    const root = join(await tempRoot(), "my project é");
    await mkdir(root);
    expect(parseDeepLink(appLink(root, "a-1"))).toEqual({ ok: true, link: { action: "open", root, boardId: "a-1" } });
  });

  it("rejects relative roots, .. segments and missing directories", async () => {
    const root = await tempRoot();
    expect(parseDeepLink("gabiro://open?root=projects/app")).toMatchObject({ ok: false, reason: /absolute/ });
    expect(parseDeepLink(appLink(`${root}/../${root.split("/").pop()}`))).toMatchObject({ ok: false, reason: /\.\./ });
    expect(parseDeepLink(appLink(join(root, "nope")))).toMatchObject({ ok: false, reason: /existing directory/ });
    expect(parseDeepLink("gabiro://open")).toMatchObject({ ok: false, reason: /missing root/ });
  });

  it("rejects a root that is a file", async () => {
    const file = join(await tempRoot(), "notes.txt");
    await writeFile(file, "hi");
    expect(parseDeepLink(appLink(file))).toMatchObject({ ok: false, reason: /existing directory/ });
  });

  it("rejects bad board ids, unknown actions, paths and other schemes", async () => {
    const root = await tempRoot();
    expect(parseDeepLink(appLink(root, "Bad Id"))).toMatchObject({ ok: false, reason: /slug/ });
    expect(parseDeepLink(appLink(root, "../x"))).toMatchObject({ ok: false, reason: /slug/ });
    expect(parseDeepLink("gabiro://delete?root=/")).toMatchObject({ ok: false, reason: /unknown action/ });
    expect(parseDeepLink("gabiro://start/extra")).toMatchObject({ ok: false, reason: /unexpected path/ });
    expect(parseDeepLink("https://start")).toMatchObject({ ok: false, reason: /scheme/ });
    expect(parseDeepLink("not a url")).toMatchObject({ ok: false, reason: /not a URL/ });
  });
});
