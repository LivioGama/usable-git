import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { errorCodeSchema } from "@usable-git/contracts/v1";

const operationSchema = z.enum(["inspect", "review", "history", "publish", "push"]);
const clientSchema = z.enum(["codex", "claude-code", "cursor-agent", "devin-cli", "other"]);
const transportSchema = z.enum(["mcp", "cli"]);
const resultCodeSchema = z.union([z.literal("success"), errorCodeSchema]);

const aggregateCountsSchema = z
  .object({
    selected: z.number().int().nonnegative(),
    staged: z.number().int().nonnegative(),
    unstaged: z.number().int().nonnegative(),
    untracked: z.number().int().nonnegative(),
    conflicted: z.number().int().nonnegative(),
    commits: z.number().int().nonnegative(),
    warnings: z.number().int().nonnegative(),
  })
  .strict();

const componentVersionsSchema = z
  .object({
    usableGit: z.string().min(1).max(128),
    bun: z.string().min(1).max(128),
    git: z.string().min(1).max(128),
    client: z.string().min(1).max(128),
  })
  .strict();

export const telemetryEventSchema = z
  .object({
    version: z.literal("v1"),
    operation: operationSchema,
    client: clientSchema,
    transport: transportSchema,
    backend: z.literal("git-cli"),
    durationMs: z.number().finite().nonnegative(),
    gitSubprocessCount: z.number().int().nonnegative(),
    resultCode: resultCodeSchema,
    counts: aggregateCountsSchema,
    components: componentVersionsSchema,
    repositoryHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

const telemetryEventInputSchema = telemetryEventSchema
  .omit({ version: true, backend: true, repositoryHash: true })
  .extend({ repositoryIdentity: z.string().min(1) })
  .strict();

export type TelemetryEvent = z.infer<typeof telemetryEventSchema>;
export type TelemetryEventInput = z.infer<typeof telemetryEventInputSchema>;

export type TelemetryWriteResult =
  | { written: false; reason: "disabled" }
  | { written: true; repositoryHash: string };

export interface TelemetrySink {
  emit: (input: TelemetryEventInput) => Promise<TelemetryWriteResult>;
}

export interface TelemetrySinkOptions {
  enabled?: boolean;
  stateRoot?: string;
}

const getDefaultStateRoot = () =>
  process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");

const getOrCreateSalt = async (directory: string) => {
  const saltPath = join(directory, "telemetry-v1.salt");

  try {
    return (await readFile(saltPath, "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const salt = randomBytes(32).toString("hex");

  try {
    const handle = await open(saltPath, "wx", 0o600);
    try {
      await handle.writeFile(`${salt}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return salt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return (await readFile(saltPath, "utf8")).trim();
    }
    throw error;
  }
};

const hashRepository = (salt: string, repositoryIdentity: string) =>
  createHash("sha256").update(salt).update("\0").update(repositoryIdentity).digest("hex");

export const createTelemetrySink = (options: TelemetrySinkOptions = {}): TelemetrySink => {
  const enabled = options.enabled === true;
  const directory = join(options.stateRoot ?? getDefaultStateRoot(), "usable-git");

  return {
    emit: async (rawInput) => {
      if (!enabled) {
        return { written: false, reason: "disabled" };
      }

      const input = telemetryEventInputSchema.parse(rawInput);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const salt = await getOrCreateSalt(directory);
      const repositoryHash = hashRepository(salt, input.repositoryIdentity);
      const event = telemetryEventSchema.parse({
        version: "v1",
        operation: input.operation,
        client: input.client,
        transport: input.transport,
        backend: "git-cli",
        durationMs: input.durationMs,
        gitSubprocessCount: input.gitSubprocessCount,
        resultCode: input.resultCode,
        counts: input.counts,
        components: input.components,
        repositoryHash,
      });
      const eventPath = join(directory, "telemetry-v1.jsonl");
      const handle = await open(eventPath, "a", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }

      return { written: true, repositoryHash };
    },
  };
};
