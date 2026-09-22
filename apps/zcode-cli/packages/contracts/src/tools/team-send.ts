import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const TEAM_SEND_TOOL_NAME = "team_send";
export const TEAM_SEND_MAX_CONTENT_CHARS = 20_000;

export const TeamSendInputSchema = z
  .object({
    to: z.string().min(1).max(200).describe("Recipient teammate name within the current team."),
    summary: z.string().min(1).max(200).describe("A 5-10 word summary shown as a preview."),
    message: z
      .string()
      .min(1)
      .max(TEAM_SEND_MAX_CONTENT_CHARS)
      .describe("Plain text message content"),
  })
  .strict();

export type TeamSendInput = z.infer<typeof TeamSendInputSchema>;

export const TeamSendInputJsonSchema = toToolJsonSchema(TeamSendInputSchema);

export const TeamSendOutputSchema = z
  .object({
    status: z.enum(["success", "failed"]),
    messageId: z.string(),
    message: z.string(),
    error: z.string().optional(),
    delivery: z.enum(["queued", "steered", "resumed_background"]).optional(),
  })
  .strict();

export type TeamSendOutput = z.infer<typeof TeamSendOutputSchema>;
