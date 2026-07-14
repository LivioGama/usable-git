import { isAbsolute } from "node:path";
import { z } from "zod";

export const absolutePathSchema = z
  .string()
  .min(1)
  .refine(isAbsolute, "repoPath must be absolute");

export const literalFileSchema = z.string().min(1);

const repositoryRequestSchema = z.object({
  repoPath: absolutePathSchema,
});

export const inspectRequestSchema = repositoryRequestSchema.extend({
  files: z.array(literalFileSchema).min(1).optional(),
});

export const reviewRequestSchema = repositoryRequestSchema.extend({
  files: z.array(literalFileSchema).min(1).optional(),
  cursor: z.string().min(1).optional(),
  byteCap: z.number().int().min(128).max(1_000_000).default(64_000),
});

export const historyRequestSchema = repositoryRequestSchema.extend({
  ref: z.string().min(1).default("HEAD"),
  limit: z.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).optional(),
  byteCap: z.number().int().min(1_024).max(1_000_000).optional(),
});

export const errorCodeSchema = z.enum([
  "INVALID_INPUT",
  "INVALID_REPOSITORY",
  "INVALID_PATH",
  "UNSUPPORTED_STATE",
  "STALE_STATE",
  "BUSY_REPOSITORY",
  "NOTHING_TO_COMMIT",
  "HOOK_FAILED",
  "SIGNING_FAILED",
  "IDENTITY_MISSING",
  "AUTH_FAILED",
  "NON_FAST_FORWARD",
  "LEASE_REJECTED",
  "NETWORK_AMBIGUITY",
  "RECOVERY_CONFLICT",
  "INVARIANT_VIOLATION",
  "GIT_FAILED",
]);

const envelopeBaseSchema = z.object({
  version: z.literal("v1"),
  operationId: z.string().min(1),
  backend: z.literal("git-cli"),
  durationMs: z.number().nonnegative(),
  gitProcessCount: z.number().int().nonnegative(),
  warnings: z.array(z.string()),
  repository: z.record(z.string(), z.unknown()).optional(),
});

export const v1EnvelopeSchema = z.discriminatedUnion("ok", [
  envelopeBaseSchema.extend({
    ok: z.literal(true),
    result: z.unknown(),
  }),
  envelopeBaseSchema.extend({
    ok: z.literal(false),
    error: z.object({
      code: errorCodeSchema,
      message: z.string(),
      details: z.record(z.string(), z.unknown()).optional(),
    }),
  }),
]);

export type InspectRequest = z.infer<typeof inspectRequestSchema>;
export type ReviewRequest = z.input<typeof reviewRequestSchema>;
export type HistoryRequest = z.input<typeof historyRequestSchema>;
export type ErrorCode = z.infer<typeof errorCodeSchema>;
export type V1Envelope = z.infer<typeof v1EnvelopeSchema>;
