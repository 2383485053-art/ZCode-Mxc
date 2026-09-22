import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";
import { TEAM_TASK_SCHEMA } from "../interfaces/team.port.js";

export const TASK_CREATE_TOOL_NAME = "task_create";
export const TASK_CREATE_MAX_DESCRIPTION_CHARS = 20_000;

export const TaskCreateInputSchema = z
  .object({
    subject: z.string().min(1).max(500).describe("Imperative one-liner, e.g. 'Run the auth test suite'."),
    description: z
      .string()
      .max(TASK_CREATE_MAX_DESCRIPTION_CHARS)
      .optional()
      .describe("What done means: acceptance criteria, files to touch, constraints."),
    active_form: z
      .string()
      .max(200)
      .optional()
      .describe("Present-progressive label for UI, e.g. 'Running auth tests'."),
    blocked_by: z
      .array(z.string().min(1))
      .max(20)
      .optional()
      .describe("Task ids that must be completed/cancelled before this task can start."),
    shared_context: z
      .array(z.string())
      .max(50)
      .optional()
      .describe("Contract files the assignee should read first (repo-relative paths)."),
    scope: z
      .array(z.string().min(1))
      .max(20)
      .optional()
      .describe(
        "Write-range globs (repo-relative, e.g. ['src/auth/**']). Scoped tasks run inside the writer's own worktree; runtime writes outside scope are vetoed. Scopes of open tasks must not overlap.",
      ),
  })
  .strict();

export type TaskCreateInput = z.infer<typeof TaskCreateInputSchema>;

export const TaskCreateInputJsonSchema = toToolJsonSchema(TaskCreateInputSchema);

export const TaskCreateOutputSchema = z
  .object({
    status: z.enum(["success", "failed"]),
    task_id: z.string().optional(),
    task: TEAM_TASK_SCHEMA.optional(),
    message: z.string(),
    error: z.string().optional(),
  })
  .strict();

export type TaskCreateOutput = z.infer<typeof TaskCreateOutputSchema>;
