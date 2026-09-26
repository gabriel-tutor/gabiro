import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerMessage } from "../../src/server/protocol.js";
import { LiveClient } from "../../web/src/live.js";

/** Minimal stand-in for the browser WebSocket that lets the test push raw frames. */
class FakeSocket {
  static OPEN = 1;
  static last: FakeSocket | undefined;
  readyState = 0;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
  constructor(readonly url: string) {
    FakeSocket.last = this;
  }
  send() {}
  close() {}
}

afterEach(() => vi.unstubAllGlobals());

describe("LiveClient", () => {
  it("ignores frames that aren't JSON and keeps delivering later messages", () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    const client = new LiveClient("ws://127.0.0.1:1/ws");
    const received: ServerMessage[] = [];
    client.onMessage((m) => received.push(m));
    const socket = FakeSocket.last!;
    expect(() => socket.onmessage!({ data: "{ broken" })).not.toThrow();
    socket.onmessage!({ data: JSON.stringify({ type: "boards", boards: [] }) });
    expect(received).toEqual([{ type: "boards", boards: [] }]);
    client.close();
  });
});
