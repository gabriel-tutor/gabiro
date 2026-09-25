import { z } from "zod";
import { ALL_EDGE_TYPES, ALL_GROUP_TYPES, ALL_NODE_TYPES, KINDS } from "./kinds.js";

export const SlugSchema = z
  .string()
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "must be a lowercase slug like 'orders-db' (a-z, 0-9, '-')");

export const PositionSchema = z.object({ x: z.number(), y: z.number() });

export const FieldSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  pk: z.boolean().optional(),
  fk: z.boolean().optional(),
  nullable: z.boolean().optional(),
});

export const NodeSchema = z.object({
  id: SlugSchema,
  type: z.enum(ALL_NODE_TYPES),
  label: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  tech: z.string().max(100).optional(),
  groupId: SlugSchema.optional(),
  tags: z.array(z.string()).optional(),
  color: z.string().optional(),
  position: PositionSchema.optional(),
  pinned: z.boolean().optional(),
  order: z.number().int().optional(),
  fields: z.array(FieldSchema).optional(),
});

export const EdgeSchema = z.object({
  id: z.string().min(1).max(140),
  from: SlugSchema,
  to: SlugSchema,
  type: z.enum(ALL_EDGE_TYPES),
  label: z.string().max(200).optional(),
  order: z.number().int().optional(),
  style: z.enum(["solid", "dashed"]).optional(),
  cardinality: z.enum(["1-1", "1-n", "n-n"]).optional(),
});

export const GroupSchema = z.object({
  id: SlugSchema,
  label: z.string().min(1).max(200),
  type: z.enum(ALL_GROUP_TYPES),
  parentId: SlugSchema.optional(),
});

export const BoardSchema = z.object({
  id: SlugSchema,
  title: z.string().min(1).max(200),
  kind: z.enum(KINDS),
  revision: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
  layout: z.object({ direction: z.enum(["LR", "TB"]) }),
  groups: z.array(GroupSchema),
  nodes: z.array(NodeSchema),
  edges: z.array(EdgeSchema),
});

export type Position = z.infer<typeof PositionSchema>;
export type Field = z.infer<typeof FieldSchema>;
export type BoardNode = z.infer<typeof NodeSchema>;
export type BoardEdge = z.infer<typeof EdgeSchema>;
export type BoardGroup = z.infer<typeof GroupSchema>;
export type Board = z.infer<typeof BoardSchema>;
export type Direction = Board["layout"]["direction"];
