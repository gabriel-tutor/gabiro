import { useLiveBoards } from "./hooks.js";

export function BoardList() {
  const boards = useLiveBoards();
  return (
    <div className="gb-page">
      <header className="gb-header">
        <h1>gabiro</h1>
        <span className="gb-meta">boards in this project</span>
      </header>
      <main className="gb-list">
        {boards === undefined && <p className="gb-empty">Loading…</p>}
        {boards?.length === 0 && (
          <p className="gb-empty">
            No boards yet. Ask your agent to create one, e.g. “Map this repo’s architecture as a gabiro board.”
          </p>
        )}
        <ul>
          {boards?.map((b) => (
            <li key={b.id} className={b.error ? "gb-list-error" : undefined}>
              <a href={`/b/${b.id}`}>
                <span className="gb-list-title">{b.title}</span>
                <span className="gb-kind">{b.kind}</span>
                <span className="gb-list-meta">
                  {b.error ? b.error : `${b.nodeCount} nodes · updated ${new Date(b.updatedAt).toLocaleString()}`}
                </span>
              </a>
            </li>
          ))}
        </ul>
      </main>
    </div>
  );
}
