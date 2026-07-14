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
    message: z.string().trim().min(1).max(65_536),
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

export type PublishRequest = z.infer<typeof publishRequestSchema>;
export type ExpectedHead = z.infer<typeof expectedHeadSchema>;
