import { afterEach, describe, expect, it } from "vitest";
import { appLink, openCanvas, startCanvasServer, type CanvasServer, type OpenCanvasOptions } from "../../src/server/index.js";
import { tempRoot } from "../helpers.js";

const servers: CanvasServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

/** Fakes for everything openCanvas touches; `links` and `browsed` record what it opened. */
function fakes(overrides: OpenCanvasOptions = {}) {
  const links: string[] = [];
  const browsed: string[] = [];
  const options: OpenCanvasOptions = {
    platform: "darwin",
    env: {},
    appInstalled: () => true,
    openLink: (link) => (links.push(link), true),
    ensure: async () => "http://127.0.0.1:4477",
    openBrowser: (url) => (browsed.push(url), true),
    appTimeoutMs: 300,
    ...overrides,
  };
  return { options, links, browsed };
}

describe("openCanvas", () => {
  it("asks the Mac app and returns the URL of the server it serves the project from", async () => {
    const root = await tempRoot();
    const { options, links, browsed } = fakes({ appTimeoutMs: 5000 });
    // The "app" starts a canvas server for the project when it receives the link.
    options.openLink = (link) => {
      links.push(link);
      void startCanvasServer({ root, port: 0, webDir: root }).then((s) => servers.push(s));
      return true;
    };
    const result = await openCanvas(root, "checkout", options);
    expect(links).toEqual([appLink(root, "checkout")]);
    expect(result).toEqual({ url: `${servers[0]!.url}/b/checkout`, via: "app" });
    expect(browsed).toEqual([]);
  });

  it("falls back to the browser when the app doesn't serve the project in time", async () => {
    const root = await tempRoot();
    const { options, links, browsed } = fakes();
    const result = await openCanvas(root, undefined, options);
    expect(links).toHaveLength(1);
    expect(result).toEqual({ url: "http://127.0.0.1:4477", via: "browser", appTimedOut: true });
    expect(browsed).toEqual(["http://127.0.0.1:4477"]);
  });

  it("uses the browser when not on macOS, the app isn't installed, or GABIRO_NO_APP is set", async () => {
    const root = await tempRoot();
    for (const overrides of [{ platform: "linux" as const }, { appInstalled: () => false }, { env: { GABIRO_NO_APP: "1" } }]) {
      const { options, links, browsed } = fakes(overrides);
      expect(await openCanvas(root, "shop", options)).toEqual({ url: "http://127.0.0.1:4477/b/shop", via: "browser" });
      expect(links).toEqual([]);
      expect(browsed).toEqual(["http://127.0.0.1:4477/b/shop"]);
    }
  });

  it("opens nothing with GABIRO_NO_BROWSER but still returns the running canvas", async () => {
    const root = await tempRoot();
    const { options, links, browsed } = fakes({ env: { GABIRO_NO_BROWSER: "1" } });
    expect(await openCanvas(root, undefined, options)).toEqual({ url: "http://127.0.0.1:4477", via: "none" });
    expect(links).toEqual([]);
    expect(browsed).toEqual([]);
  });

  it("reports via none when the browser can't be opened", async () => {
    const root = await tempRoot();
    const { options } = fakes({ platform: "linux", openBrowser: () => false });
    expect(await openCanvas(root, undefined, options)).toEqual({ url: "http://127.0.0.1:4477", via: "none" });
  });
});
