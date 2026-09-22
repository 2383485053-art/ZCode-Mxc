import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";
import { TEAM_TASK_SCHEMA } from "../interfaces/team.port.js";

export const TEAM_COLLECT_TOOL_NAME = "team_collect";
export const TEAM_COLLECT_DEFAULT_TIMEOUT_MS = 120_000;
export const TEAM_COLLECT_MIN_TIMEOUT_MS = 1_000;
export const TEAM_COLLECT_MAX_TIMEOUT_MS = 600_000;

export const TeamCollectInputSchema = z
  .object({
    timeout_ms: z
      .number()
      .int()
      .min(TEAM_COLLECT_MIN_TIMEOUT_MS)
      .max(TEAM_COLLECT_MAX_TIMEOUT_MS)
      .optional()
      .describe(`How long to wait for results (ms, 1000-${TEAM_COLLECT_MAX_TIMEOUT_MS}; default ${TEAM_COLLECT_DEFAULT_TIMEOUT_MS}).`),
    require_all: z
      .boolean()
      .optional()
      .describe("true (default): wait for every open task; false: return when the first one finishes."),
  })
  .strict();

export type TeamCollectInput = z.infer<typeof TeamCollectInputSchema>;

export const TeamCollectInputJsonSchema = toToolJsonSchema(TeamCollectInputSchema);

export const TeamCollectOutputSchema = z
  .object({
    status: z.enum(["completed", "partial", "timeout", "failed"]),
    tasks: z.array(TEAM_TASK_SCHEMA),
    message: z.string(),
    error: z.string().optional(),
  })
  .strict();

export type TeamCollectOutput = z.infer<typeof TeamCollectOutputSchema>;
