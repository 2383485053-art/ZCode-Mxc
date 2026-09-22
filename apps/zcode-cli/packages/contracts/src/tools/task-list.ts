import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";
import { TEAM_TASK_SCHEMA } from "../interfaces/team.port.js";

export const TASK_LIST_TOOL_NAME = "task_list";

export const TaskListInputSchema = z.object({}).strict();

export type TaskListInput = z.infer<typeof TaskListInputSchema>;

export const TaskListInputJsonSchema = toToolJsonSchema(TaskListInputSchema);

export const TaskListOutputSchema = z
  .object({
    status: z.enum(["success", "failed"]),
    tasks: z.array(TEAM_TASK_SCHEMA),
    message: z.string(),
    error: z.string().optional(),
  })
  .strict();

export type TaskListOutput = z.infer<typeof TaskListOutputSchema>;
