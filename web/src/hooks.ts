import { useEffect, useState } from "react";
import type { Board } from "../../src/core/index.js";
import type { BoardListItem } from "../../src/store/store.js";
import { LiveClient } from "./live.js";
import { changedIds } from "./toFlow.js";

const FLASH_MS = 1500;

export interface LiveBoard {
  board?: Board;
  /** Set when the board can't be shown as-is (missing, corrupt); the last good board stays visible. */
  error?: { code: string; message: string };
  changed: Set<string>;
  connected: boolean;
}

/** Subscribes to one board and keeps the latest snapshot, plus which ids just changed. */
export function useLiveBoard(boardId: string): LiveBoard {
  const [state, setState] = useState<LiveBoard>({ changed: new Set(), connected: false });

  useEffect(() => {
    const client = new LiveClient();
    client.subscribe({ type: "subscribe", boardId });
    const offStatus = client.onStatus((connected) => setState((s) => ({ ...s, connected })));
    const offMessage = client.onMessage((msg) => {
      if (msg.type === "board" && msg.board.id === boardId) {
        setState((s) => ({ ...s, board: msg.board, error: undefined, changed: changedIds(s.board, msg.board) }));
      } else if (msg.type === "board-error" && msg.boardId === boardId) {
        setState((s) => ({ ...s, error: { code: msg.code, message: msg.message } }));
      }
    });
    return () => {
      offStatus();
      offMessage();
      client.close();
    };
  }, [boardId]);

  useEffect(() => {
    if (!state.changed.size) return;
    const timer = setTimeout(() => setState((s) => ({ ...s, changed: new Set() })), FLASH_MS);
    return () => clearTimeout(timer);
  }, [state.changed]);

  return state;
}

/** Subscribes to the list of boards. `undefined` until the first list arrives. */
export function useLiveBoards(): BoardListItem[] | undefined {
  const [boards, setBoards] = useState<BoardListItem[]>();
  useEffect(() => {
    const client = new LiveClient();
    client.subscribe({ type: "subscribe-list" });
    const off = client.onMessage((msg) => {
      if (msg.type === "boards") setBoards(msg.boards);
    });
    return () => {
      off();
      client.close();
    };
  }, []);
  return boards;
}
