import type { ClientMessage, ServerMessage } from "../../src/server/protocol.js";

type Listener = (msg: ServerMessage) => void;
type StatusListener = (connected: boolean) => void;

/** WebSocket connection to the canvas server that re-subscribes and reconnects with backoff. */
export class LiveClient {
  private ws?: WebSocket;
  private readonly subscriptions: ClientMessage[] = [];
  private readonly listeners = new Set<Listener>();
  private readonly statusListeners = new Set<StatusListener>();
  private closed = false;
  private attempt = 0;

  constructor(private readonly url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`) {
    this.connect();
  }

  private connect(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      for (const sub of this.subscriptions) ws.send(JSON.stringify(sub));
      this.statusListeners.forEach((l) => l(true));
    };
    ws.onmessage = (event) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return; // ignore a bad frame rather than break the socket handler
      }
      this.listeners.forEach((l) => l(msg));
    };
    ws.onclose = () => {
      this.statusListeners.forEach((l) => l(false));
      if (!this.closed) setTimeout(() => this.connect(), Math.min(5000, 250 * 2 ** this.attempt++));
    };
  }

  subscribe(msg: ClientMessage): void {
    this.subscriptions.push(msg);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  onMessage(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }
}
