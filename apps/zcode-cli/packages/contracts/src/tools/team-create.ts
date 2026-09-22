import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";
import { TEAM_NAME_SCHEMA } from "../interfaces/team.port.js";

export const TEAM_CREATE_TOOL_NAME = "team_create";

export const TeamCreateInputSchema = z
  .object({
    name: TEAM_NAME_SCHEMA.describe(
      "Team name (1-32 chars: letters, digits, _ or -). Only one team can be active at a time.",
    ),
  })
  .strict();

export type TeamCreateInput = z.infer<typeof TeamCreateInputSchema>;

export const TeamCreateInputJsonSchema = toToolJsonSchema(TeamCreateInputSchema);

export const TeamCreateOutputSchema = z
  .object({
    status: z.enum(["success", "failed"]),
    teamName: z.string().optional(),
    message: z.string(),
    error: z.string().optional(),
  })
  .strict();

export type TeamCreateOutput = z.infer<typeof TeamCreateOutputSchema>;
