import { z } from "zod";
import {
  operationSchema,
  v1EnvelopeSchema,
  type ErrorCode,
  type V1Envelope,
} from "./contracts/v1.ts";
import { UsableGitError } from "./errors.ts";
import { GitCommandError, withGitMetrics } from "./git/runner.ts";
import { history } from "./operations/history.ts";
import { inspect } from "./operations/inspect.ts";
import { review } from "./operations/review.ts";

export type Operation = z.infer<typeof operationSchema>;
export type ServiceOptions = { transport: "mcp" | "cli" };

const requestedPath = (input: unknown) =>
  input && typeof input === "object" && "repoPath" in input && typeof input.repoPath === "string"
    ? input.repoPath
    : "<missing>";

const requestId = (input: unknown) =>
  input && typeof input === "object" && "requestId" in input && typeof input.requestId === "string"
    ? input.requestId
    : undefined;

const invoke = async (operation: Operation, input: unknown) => {
  switch (operation) {
    case "inspect":
      return inspect(input as Parameters<typeof inspect>[0]);
    case "review":
      return review(input as Parameters<typeof review>[0]);
    case "history":
      return history(input as Parameters<typeof history>[0]);
    case "publish": {
      const { publish } = await import("./operations/publish.ts");
      return publish(input as Parameters<typeof publish>[0]);
    }
    case "push": {
      const { push } = await import("./operations/push.ts");
      return push(input as Parameters<typeof push>[0]);
    }
  }
};

const sanitizeDiagnostic = (message: string) =>
  message
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1<redacted>@")
    .slice(0, 2_000);

const classifyError = (error: unknown): { code: ErrorCode; message: string } => {
  if (error instanceof UsableGitError) {
    return { code: error.code, message: sanitizeDiagnostic(error.message) };
  }
  if (error instanceof z.ZodError) {
    return { code: "INVALID_INPUT", message: "Request failed v1 validation" };
  }
  if (error instanceof GitCommandError) {
    const diagnostic = error.stderr || error.message;
    return {
      code: /not a git repository/i.test(diagnostic) ? "INVALID_REPOSITORY" : "GIT_FAILED",
      message: sanitizeDiagnostic(diagnostic.trim() || "Git command failed"),
    };
  }
  return {
    code: "INVARIANT_VIOLATION",
    message: error instanceof Error ? sanitizeDiagnostic(error.message) : "Unknown operation failure",
  };
};

const repositoryState = (input: unknown, result?: unknown) => {
  const requested = requestedPath(input);
  const value = result && typeof result === "object" ? result as Record<string, unknown> : undefined;
  const repository = value?.repository && typeof value.repository === "object"
    ? value.repository as Record<string, unknown>
    : undefined;
  const branch = value?.branch && typeof value.branch === "object"
    ? value.branch as Record<string, unknown>
    : undefined;
  const head = value?.head && typeof value.head === "object"
    ? value.head
    : branch?.oid && typeof branch.oid === "string"
      ? { kind: "oid", oid: branch.oid }
      : branch?.oid === null
        ? { kind: "unborn" }
        : { kind: "unknown" };
  return {
    requestedPath: requested,
    root: typeof repository?.root === "string" ? repository.root : null,
    head,
    branch: typeof branch?.head === "string" ? branch.head : null,
  };
};

export const executeOperation = async (
  rawOperation: Operation,
  input: unknown,
  options: ServiceOptions,
): Promise<V1Envelope> => {
  const startedAt = performance.now();
  const operation = operationSchema.parse(rawOperation);
  try {
    const measured = await withGitMetrics(() => invoke(operation, input));
    return v1EnvelopeSchema.parse({
      version: "v1",
      ok: true,
      operation,
      ...(requestId(input) ? { requestId: requestId(input) } : {}),
      repository: repositoryState(input, measured.result),
      backend: "git-cli",
      transport: options.transport,
      durationMs: performance.now() - startedAt,
      gitSubprocessCount: measured.gitSubprocessCount,
      warnings: [],
      result: measured.result,
    });
  } catch (error) {
    return v1EnvelopeSchema.parse({
      version: "v1",
      ok: false,
      operation,
      ...(requestId(input) ? { requestId: requestId(input) } : {}),
      repository: repositoryState(input),
      backend: "git-cli",
      transport: options.transport,
      durationMs: performance.now() - startedAt,
      gitSubprocessCount: 0,
      warnings: [],
      error: classifyError(error),
    });
  }
};
