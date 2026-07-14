import { isAbsolute, normalize } from "node:path";
import { z } from "zod";

const requestIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,128}$/);

const objectIdSchema = z
  .string()
  .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);

const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);

const literalPublishFileSchema = z.string().min(1).superRefine((file, context) => {
  if (
    file === "." ||
    isAbsolute(file) ||
    file.startsWith(":") ||
    /[*?[\]]/.test(file) ||
    normalize(file) !== file ||
    file.split(/[\\/]/).includes("..")
  ) {
    context.addIssue({
      code: "custom",
      message: "publish files must be literal repository-relative file paths",
    });
  }
});

export const expectedHeadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("oid"), oid: objectIdSchema }).strict(),
  z.object({ kind: z.literal("unborn") }).strict(),
]);

export const publishRequestSchema = z
  .object({
    repoPath: z.string().min(1).refine(isAbsolute, "repoPath must be absolute"),
    files: z.array(literalPublishFileSchema).min(1).max(10_000),
    message: z.string().max(65_536).refine((value) => value.trim().length > 0, "message must not be blank"),
    requestId: requestIdSchema,
    expectedHead: expectedHeadSchema,
    expectedFingerprints: z.record(z.string(), fingerprintSchema),
  })
  .strict()
  .superRefine((request, context) => {
    const files = new Set(request.files);
    if (files.size !== request.files.length) {
      context.addIssue({
        code: "custom",
        path: ["files"],
        message: "publish files must be unique",
      });
    }

    const fingerprintPaths = Object.keys(request.expectedFingerprints);
    if (
      fingerprintPaths.length !== files.size ||
      fingerprintPaths.some((path) => !files.has(path))
    ) {
      context.addIssue({
        code: "custom",
        path: ["expectedFingerprints"],
        message: "expectedFingerprints must contain exactly one entry for every file",
      });
    }
  });

export const publishResultSchema = z
  .object({
    commitOid: objectIdSchema,
    committedPaths: z.array(literalPublishFileSchema),
    head: z
      .object({
        oid: objectIdSchema,
        branch: z.string().min(1),
      })
      .strict(),
    status: z
      .object({
        staged: z.array(literalPublishFileSchema),
        unstaged: z.array(literalPublishFileSchema),
        untracked: z.array(literalPublishFileSchema),
        conflicted: z.array(literalPublishFileSchema),
      })
      .strict(),
    warnings: z.array(z.string()),
  })
  .strict();

export type PublishRequest = z.infer<typeof publishRequestSchema>;
export type ExpectedHead = z.infer<typeof expectedHeadSchema>;
export type PublishResult = z.infer<typeof publishResultSchema>;
