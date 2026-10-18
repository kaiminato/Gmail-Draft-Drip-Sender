import { z } from "zod";

// What the extension sends every half minute. Everything is optional-tolerant
// so an older extension build never gets a 400 for a missing field, and
// unknown fields are dropped.
// Event fields are cut to size rather than rejected: a rejected event stays at
// the front of the extension's queue and fails every heartbeat after it, which
// took an account offline for half a day over one draft with 100 recipients.
const cut = (n: number) => z.string().transform((s) => s.slice(0, n));
const cutList = (items: number, each: number) =>
  z.array(z.string()).transform((a) => a.slice(0, items).map((s) => s.slice(0, each)));

const eventSchema = z
  .object({
    id: z.string().min(1).max(80),
    t: z.number().finite(),
    type: z.enum(["sent", "failed", "blocked", "bounce", "started", "stopped"]),
    subject: cut(500).optional(),
    recipients: cutList(50, 320).optional(),
    from: cut(320).optional(),
    reason: cut(100).optional(),
    code: cut(100).optional(),
    message: cut(2000).optional(),
    subjects: cutList(20, 500).optional(),
    source: cut(50).optional(),
    tier: cut(20).optional(),
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
  tier: z.enum(["few", "less", "normal", "many"]).optional(),
  tierSetAt: z.number().optional(),
  dayTarget: z.number().int().nullable().optional(),
  plannedLeft: z.number().int().nullable().optional(),
  restStart: z.string().max(10).optional(),
  restEnd: z.string().max(10).optional(),
  nextSendAt: z.number().optional(),
  lastSendAt: z.number().optional(),
  remainingBucket: z.enum(["unknown", "none", "1-10", "10+"]).optional(),
  remainingCount: z.number().int().nullable().optional(),
  sentToday: z.number().int().nonnegative().optional(),
  totalSent: z.number().int().nonnegative().optional(),
  bounceCount: z.number().int().nonnegative().optional(),
  consecutiveFailures: z.number().int().nonnegative().optional(),
  gmailTabOpen: z.boolean().optional(),
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
  command: { id: string; type: "start"; tier?: string } | { id: string; type: "stop" } | null;
};
