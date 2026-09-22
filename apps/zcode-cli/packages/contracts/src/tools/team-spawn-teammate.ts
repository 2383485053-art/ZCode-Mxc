import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const TEAM_SPAWN_TEAMMATE_TOOL_NAME = "team_spawn_teammate";

export const TeamSpawnTeammateInputSchema = z
  .object({
    name: z.string().min(1).max(32).describe("Teammate name, unique within the team (1-32 chars)."),
    profile: z
      .string()
      .min(1)
      .max(200)
      .describe("Subagent profile/agentType for the teammate (e.g. 'general-purpose')."),
    readOnly: z.boolean().optional().describe("Mark the teammate read-only (enforced from M2)."),
    maxTurns: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe("Per-run turn budget; defaults to 20 for teammates (profiles may override)."),
  })
  .strict();

export type TeamSpawnTeammateInput = z.infer<typeof TeamSpawnTeammateInputSchema>;

export const TeamSpawnTeammateInputJsonSchema = toToolJsonSchema(TeamSpawnTeammateInputSchema);

export const TeamSpawnTeammateOutputSchema = z
  .object({
    status: z.enum(["success", "failed"]),
    teamName: z.string().optional(),
    memberName: z.string().optional(),
    agentId: z.string().optional(),
    message: z.string(),
    roster: z
      .array(
        z.object({
          name: z.string(),
          state: z.string(),
          profile: z.string().optional(),
          readOnly: z.boolean().optional(),
        }),
      )
      .optional(),
    error: z.string().optional(),
  })
  .strict();

export type TeamSpawnTeammateOutput = z.infer<typeof TeamSpawnTeammateOutputSchema>;
