import { BoardList } from "./BoardList.js";
import { BoardView } from "./BoardView.js";

/** Two routes, resolved from the URL: "/" lists boards, "/b/<id>" shows one. */
export function App() {
  const match = /^\/b\/([^/]+)\/?$/.exec(window.location.pathname);
  return match ? <BoardView boardId={decodeURIComponent(match[1]!)} /> : <BoardList />;
}
