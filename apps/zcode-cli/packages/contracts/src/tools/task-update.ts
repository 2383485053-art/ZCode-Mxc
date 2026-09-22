import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";
import { TEAM_TASK_SCHEMA, TEAM_TASK_STATUS_SCHEMA } from "../interfaces/team.port.js";

export const TASK_UPDATE_TOOL_NAME = "task_update";

export const TaskUpdateInputSchema = z
  .object({
    task_id: z.string().min(1).describe("Task id as shown on the board, e.g. '3'."),
    status: TEAM_TASK_STATUS_SCHEMA.optional().describe(
      "pending=release back to the board; in_progress=claim/start (unowned tasks only, dependencies must be terminal); completed=done (your own in_progress task); cancelled=lead only.",
    ),
    owner: z
      .string()
      .min(1)
      .optional()
      .describe("Assignee name. Only the lead may set this; members claim via status=in_progress."),
  })
  .strict();

export type TaskUpdateInput = z.infer<typeof TaskUpdateInputSchema>;

export const TaskUpdateInputJsonSchema = toToolJsonSchema(TaskUpdateInputSchema);

export const TaskUpdateOutputSchema = z
  .object({
    status: z.enum(["success", "failed"]),
    task: TEAM_TASK_SCHEMA.optional(),
    message: z.string(),
    error: z.string().optional(),
  })
  .strict();

export type TaskUpdateOutput = z.infer<typeof TaskUpdateOutputSchema>;
