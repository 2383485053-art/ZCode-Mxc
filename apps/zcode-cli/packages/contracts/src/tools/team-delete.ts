import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const TEAM_DELETE_TOOL_NAME = "team_delete";

/** 单团队互斥：删除对象恒为当前活跃团队，无参数。 */
export const TeamDeleteInputSchema = z.object({}).strict();

export type TeamDeleteInput = z.infer<typeof TeamDeleteInputSchema>;

export const TeamDeleteInputJsonSchema = toToolJsonSchema(TeamDeleteInputSchema);

export const TeamDeleteOutputSchema = z
  .object({
    status: z.enum(["success", "failed"]),
    teamName: z.string().optional(),
    message: z.string(),
    error: z.string().optional(),
  })
  .strict();

export type TeamDeleteOutput = z.infer<typeof TeamDeleteOutputSchema>;
