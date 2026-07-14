import { z } from "zod";
import { objectIdSchema, operationHeadSchema } from "./result-primitives.ts";

const identitySchema = z
  .object({
    name: z.string(),
    email: z.string(),
  })
  .strict();

export const historyCommitSchema = z
  .object({
    oid: objectIdSchema,
    parents: z.array(objectIdSchema),
    author: identitySchema,
    committer: identitySchema,
    authoredAt: z.string().min(1),
    committedAt: z.string().min(1),
    signatureStatus: z.string().length(1),
    message: z.string(),
  })
  .strict();

export const historyResultSchema = z
  .object({
    head: operationHeadSchema,
    commits: z.array(historyCommitSchema),
    bytes: z.number().int().nonnegative(),
    nextCursor: z.string().min(1).optional(),
  })
  .strict();

export type HistoryCommit = z.infer<typeof historyCommitSchema>;
export type HistoryResult = z.infer<typeof historyResultSchema>;
