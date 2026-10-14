import { z } from "zod";

// What the extension sends once a minute. Everything is optional-tolerant so
// an older extension build never gets a 400 for a missing field.
const eventSchema = z
  .object({
    id: z.string().min(1).max(80),
    t: z.number().finite(),
    type: z.enum(["sent", "failed", "blocked", "bounce", "started", "stopped"]),
    subject: z.string().max(500).optional(),
    recipients: z.array(z.string().max(320)).max(50).optional(),
    from: z.string().max(320).optional(),
    reason: z.string().max(100).optional(),
    code: z.string().max(100).optional(),
    message: z.string().max(2000).optional(),
    subjects: z.array(z.string().max(500)).max(20).optional(),
    source: z.string().max(50).optional(),
    late: z.boolean().optional(),
    remaining: z.number().nullable().optional(),
  })
  .passthrough();

export const heartbeatSchema = z.object({
  deviceId: z.string().min(8).max(100),
  email: z.string().email().nullable().optional(),
  version: z.string().max(40).optional(),
  ts: z.number().optional(),
  trigger: z.string().max(40).optional(),
  running: z.boolean().optional(),
  busy: z.boolean().optional(),
  stopReason: z.string().max(40).optional(),
  nextSendAt: z.number().optional(),
  lastSendAt: z.number().optional(),
  remainingBucket: z.enum(["unknown", "none", "1-10", "10+"]).optional(),
  sentToday: z.number().int().nonnegative().optional(),
  totalSent: z.number().int().nonnegative().optional(),
  bounceCount: z.number().int().nonnegative().optional(),
  consecutiveFailures: z.number().int().nonnegative().optional(),
  gmailTabOpen: z.boolean().optional(),
  settings: z
    .object({
      minMinutes: z.number().optional(),
      maxMinutes: z.number().optional(),
      dailyLimit: z.number().optional(),
    })
    .optional(),
  serverSettingsAt: z.number().optional(),
  acks: z
    .array(
      z.object({
        id: z.string().max(100),
        status: z.string().max(40),
        message: z.string().max(500).optional(),
        ts: z.number().optional(),
      }),
    )
    .max(50)
    .optional(),
  events: z.array(eventSchema).max(200).optional(),
});

export type Heartbeat = z.infer<typeof heartbeatSchema>;
export type HeartbeatEvent = z.infer<typeof eventSchema>;

export type HeartbeatReply = {
  ok: true;
  serverTime: number;
  desired: { minMinutes: number; maxMinutes: number; dailyLimit: number };
  command: { id: string; type: "start" | "stop" } | null;
};
