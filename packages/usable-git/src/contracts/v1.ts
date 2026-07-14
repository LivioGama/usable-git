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

export const operationSchema = z.enum(["inspect", "review", "history", "publish", "push"]);

export const repositoryStateSchema = z.object({
  requestedPath: z.string().min(1),
  root: absolutePathSchema.nullable(),
  head: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("unknown") }).strict(),
    z.object({ kind: z.literal("unborn") }).strict(),
    z.object({ kind: z.literal("oid"), oid: z.string().regex(/^[a-f0-9]{40}$|^[a-f0-9]{64}$/) }).strict(),
  ]),
  branch: z.string().min(1).nullable(),
}).strict();

export const warningSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
}).strict();

const envelopeBase = {
  version: z.literal("v1"),
  operation: operationSchema,
  requestId: z.string().min(1).optional(),
  repository: repositoryStateSchema,
  backend: z.literal("git-cli"),
  transport: z.enum(["mcp", "cli"]),
  durationMs: z.number().nonnegative(),
  gitSubprocessCount: z.number().int().nonnegative(),
  warnings: z.array(warningSchema),
};

const operationErrorSchema = z.object({
  code: errorCodeSchema,
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const v1EnvelopeSchema = z.discriminatedUnion("ok", [
  z.object({
    ...envelopeBase,
    ok: z.literal(true),
    result: z.unknown(),
  }).strict(),
  z.object({
    ...envelopeBase,
    ok: z.literal(false),
    error: operationErrorSchema,
  }).strict(),
]);

export const v1McpEnvelopeSchema = z.object({
  ...envelopeBase,
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: operationErrorSchema.optional(),
}).strict().superRefine((value, context) => {
  const hasResult = Object.hasOwn(value, "result");
  const hasError = Object.hasOwn(value, "error");
  if (hasResult === hasError || value.ok !== hasResult) {
    context.addIssue({
      code: "custom",
      message: "ok must agree with exactly one of result or error",
    });
  }
});

export const createV1McpEnvelopeSchema = <TResult extends z.ZodType>(
  operation: z.infer<typeof operationSchema>,
  resultSchema: TResult,
) => z.object({
  ...envelopeBase,
  operation: z.literal(operation),
  ok: z.boolean(),
  result: resultSchema.optional(),
  error: operationErrorSchema.optional(),
}).strict().superRefine((value, context) => {
  const hasResult = Object.hasOwn(value, "result");
  const hasError = Object.hasOwn(value, "error");
  if (hasResult === hasError || value.ok !== hasResult) {
    context.addIssue({
      code: "custom",
      message: "ok must agree with exactly one of result or error",
    });
  }
});

export type InspectRequest = z.infer<typeof inspectRequestSchema>;
export type ReviewRequest = z.input<typeof reviewRequestSchema>;
export type HistoryRequest = z.input<typeof historyRequestSchema>;
export type ErrorCode = z.infer<typeof errorCodeSchema>;
export type V1Envelope = z.infer<typeof v1EnvelopeSchema>;
