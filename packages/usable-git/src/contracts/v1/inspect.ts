import { z } from "zod";
import {
  branchStatusSchema,
  objectIdSchema,
  operationHeadSchema,
  resultPathListSchema,
  resultPathSchema,
  resultRepositorySchema,
} from "./result-primitives.ts";

export const inspectedChangeSchema = z
  .object({
    path: resultPathSchema,
    originalPath: resultPathSchema.optional(),
    indexStatus: z.string().length(1),
    worktreeStatus: z.string().length(1),
    indexOid: objectIdSchema.optional(),
    kind: z.enum(["ordinary", "renamed", "unmerged", "untracked"]),
    conflicted: z.boolean(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const inspectResultSchema = z
  .object({
    repository: resultRepositorySchema,
    branch: branchStatusSchema,
    head: operationHeadSchema,
    stashCount: z.number().int().nonnegative(),
    inProgress: z.array(
      z.enum(["merge", "cherry-pick", "revert", "rebase", "bisect", "sequencer"]),
    ),
    staged: resultPathListSchema,
    unstaged: resultPathListSchema,
    untracked: resultPathListSchema,
    conflicted: resultPathListSchema,
    changes: z.array(inspectedChangeSchema),
  })
  .strict();

export type InspectedChange = z.infer<typeof inspectedChangeSchema>;
export type InspectResult = z.infer<typeof inspectResultSchema>;
