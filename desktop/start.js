// Start window: recent projects and Open Folder…. Talks to the main process only through window.gabiro (preload.cjs).
const list = document.getElementById("recent");
const empty = document.getElementById("empty");

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function row(project) {
  const item = el("li");
  const open = el("button", "project");
  open.append(el("span", "name", project.name));
  if (project.missing) open.append(el("span", "missing", "missing"));
  open.append(el("span", "path", project.root));
  if (!project.missing) open.append(el("span", "boards", project.boards === 1 ? "1 board" : `${project.boards} boards`));
  const remove = el("button", "remove", "Remove");
  remove.hidden = !project.missing;
  remove.addEventListener("click", async () => {
    await window.gabiro.forget(project.root);
    await refresh();
  });
  open.addEventListener("click", async () => {
    const result = project.missing ? { ok: false, missing: true } : await window.gabiro.open(project.root);
    if (result.missing && !item.querySelector(".note")) {
      open.append(el("span", "note", "This folder no longer exists."));
      remove.hidden = false;
    }
  });
  item.append(open, remove);
  return item;
}

async function refresh() {
  const projects = await window.gabiro.list();
  list.replaceChildren(...projects.map(row));
  empty.hidden = projects.length > 0;
}

document.getElementById("open-folder").addEventListener("click", () => window.gabiro.openFolder());
window.addEventListener("focus", refresh);
refresh();
