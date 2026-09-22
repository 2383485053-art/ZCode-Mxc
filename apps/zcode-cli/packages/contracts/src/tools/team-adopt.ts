import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const TEAM_ADOPT_TOOL_NAME = "team_adopt";

export const TeamAdoptInputSchema = z
  .object({
    name: z.string().min(1).max(32).describe("Name of the orphaned team to adopt (from ~/.zcode/teams)."),
  })
  .strict();

export type TeamAdoptInput = z.infer<typeof TeamAdoptInputSchema>;

export const TeamAdoptInputJsonSchema = toToolJsonSchema(TeamAdoptInputSchema);

export const TeamAdoptOutputSchema = z
  .object({
    status: z.enum(["success", "failed"]),
    team_name: z.string().optional(),
    generation: z.number().int().positive().optional(),
    adopted_members: z.number().int().nonnegative().optional(),
    released_tasks: z.number().int().nonnegative().optional(),
    pending_messages: z.number().int().nonnegative().optional(),
    message: z.string(),
    error: z.string().optional(),
  })
  .strict();

export type TeamAdoptOutput = z.infer<typeof TeamAdoptOutputSchema>;
