import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";
import { TEAM_TASK_SCHEMA } from "../interfaces/team.port.js";

export const TASK_QUERY_TOOL_NAME = "task_query";

export const TaskQueryInputSchema = z
  .object({
    task_id: z.string().min(1).describe("Task id as shown on the board, e.g. '3'."),
  })
  .strict();

export type TaskQueryInput = z.infer<typeof TaskQueryInputSchema>;

export const TaskQueryInputJsonSchema = toToolJsonSchema(TaskQueryInputSchema);

export const TaskQueryOutputSchema = z
  .object({
    status: z.enum(["success", "failed"]),
    task: TEAM_TASK_SCHEMA.optional(),
    message: z.string(),
    error: z.string().optional(),
  })
  .strict();

export type TaskQueryOutput = z.infer<typeof TaskQueryOutputSchema>;
