import { applyOps, createBoard, type Board, type Kind } from "../../src/core/index.js";

const NOW = "2026-01-01T00:00:00.000Z";
const make = (kind: Kind, ops: unknown[]): Board =>
  applyOps(createBoard({ title: `Sample ${kind}`, kind, id: `sample-${kind}`, now: NOW }), ops);

/** One small but representative board per kind. Shared by export, layout and MCP tests. */
export const FIXTURES: Record<Kind, Board> = {
  architecture: make("architecture", [
    { op: "add_group", id: "backend", label: "Backend", type: "zone" },
    { op: "add_group", id: "data", label: "Data", type: "zone", parentId: "backend" },
    { op: "add_node", id: "web", type: "client", label: "Web App" },
    { op: "add_node", id: "api", type: "service", label: "Checkout API", tech: "Node", groupId: "backend", description: "Stateless" },
    { op: "add_node", id: "orders-db", type: "database", label: "Orders DB", groupId: "data" },
    { op: "add_node", id: "events", type: "queue", label: "Events", groupId: "backend" },
    { op: "add_node", id: "stripe", type: "external", label: "Stripe" },
    { op: "add_node", id: "note", type: "sticky", label: "Add a cache?" },
    { op: "add_edge", from: "web", to: "api", type: "sync", label: "HTTPS" },
    { op: "add_edge", from: "api", to: "orders-db", type: "sync" },
    { op: "add_edge", from: "api", to: "events", type: "async", label: "order.created" },
    { op: "add_edge", from: "api", to: "stripe", type: "sync" },
  ]),
  flowchart: make("flowchart", [
    { op: "add_node", id: "start", type: "start", label: "Start" },
    { op: "add_node", id: "valid", type: "decision", label: "Email valid?" },
    { op: "add_node", id: "send", type: "step", label: "Send \"welcome\" mail" },
    { op: "add_node", id: "end", type: "end", label: "Done" },
    { op: "add_edge", from: "start", to: "valid", type: "flow" },
    { op: "add_edge", from: "valid", to: "send", type: "flow", label: "yes" },
    { op: "add_edge", from: "valid", to: "end", type: "flow", label: "no" },
    { op: "add_edge", from: "send", to: "end", type: "flow" },
  ]),
  sequence: make("sequence", [
    { op: "add_node", id: "client", type: "participant", label: "Client", order: 1 },
    { op: "add_node", id: "api", type: "participant", label: "API", order: 2 },
    { op: "add_node", id: "db", type: "participant", label: "DB", order: 3 },
    { op: "add_edge", id: "m1", from: "client", to: "api", type: "message", label: "POST /orders", order: 1 },
    { op: "add_edge", id: "m2", from: "api", to: "db", type: "message", label: "INSERT order", order: 2 },
    { op: "add_edge", id: "m3", from: "api", to: "client", type: "message", label: "201 Created", order: 3, style: "dashed" },
  ]),
  erd: make("erd", [
    { op: "add_node", id: "users", type: "entity", label: "Users", fields: [{ name: "id", type: "uuid", pk: true }, { name: "email", type: "text" }] },
    { op: "add_node", id: "orders", type: "entity", label: "Orders", fields: [{ name: "id", type: "uuid", pk: true }, { name: "user_id", type: "uuid", fk: true }] },
    { op: "add_edge", from: "users", to: "orders", type: "relation", cardinality: "1-n", label: "places" },
  ]),
  mindmap: make("mindmap", [
    { op: "add_node", id: "product", type: "topic", label: "Product" },
    { op: "add_node", id: "growth", type: "topic", label: "Growth" },
    { op: "add_node", id: "seo", type: "topic", label: "SEO" },
    { op: "add_node", id: "infra", type: "topic", label: "Infra" },
    { op: "add_edge", from: "product", to: "growth", type: "branch" },
    { op: "add_edge", from: "growth", to: "seo", type: "branch" },
    { op: "add_edge", from: "product", to: "infra", type: "branch" },
  ]),
  freeform: make("freeform", [
    { op: "add_group", id: "ideas", label: "Ideas", type: "frame" },
    { op: "add_node", id: "idea-1", type: "sticky", label: "Offline mode", groupId: "ideas" },
    { op: "add_node", id: "idea-2", type: "sticky", label: "Dark theme", description: "Users keep asking" },
  ]),
  kanban: make("kanban", [
    { op: "add_group", id: "todo", label: "To Do", type: "column" },
    { op: "add_group", id: "done", label: "Done", type: "column" },
    { op: "add_node", id: "spec", type: "card", label: "Write spec", groupId: "done", order: 1 },
    { op: "add_node", id: "mcp", type: "card", label: "Build MCP", groupId: "todo", order: 2 },
    { op: "add_node", id: "core", type: "card", label: "Build core", groupId: "todo", order: 1 },
  ]),
};
