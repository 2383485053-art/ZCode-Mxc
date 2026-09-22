import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";
import { TEAM_TASK_SCHEMA } from "../interfaces/team.port.js";

export const TEAM_MERGE_TOOL_NAME = "team_merge";

/** merge gate 七类机械拒绝（设计 2.6）：reason 是机器码，message 带下一步指引。 */
export const TEAM_MERGE_REJECTION_SCHEMA = z.enum([
  "task_not_completed",
  "owner_not_isolated",
  "member_busy",
  "dirty_worktree",
  "out_of_scope_diff",
  "base_moved",
  "git_error",
]);
export type TeamMergeRejection = z.infer<typeof TEAM_MERGE_REJECTION_SCHEMA>;

export const TeamMergeInputSchema = z
  .object({
    task_id: z.string().min(1).describe("Id of the completed task whose owner's branch should merge."),
  })
  .strict();

export type TeamMergeInput = z.infer<typeof TeamMergeInputSchema>;

export const TeamMergeInputJsonSchema = toToolJsonSchema(TeamMergeInputSchema);

export const TeamMergeOutputSchema = z
  .object({
    status: z.enum(["success", "failed"]),
    task_id: z.string().optional(),
    task: TEAM_TASK_SCHEMA.optional(),
    /** 拒绝机器码（七类之一）；成功时缺席。 */
    rejection: TEAM_MERGE_REJECTION_SCHEMA.optional(),
    merged_files: z.array(z.string()).optional(),
    message: z.string(),
    error: z.string().optional(),
  })
  .strict();

export type TeamMergeOutput = z.infer<typeof TeamMergeOutputSchema>;
