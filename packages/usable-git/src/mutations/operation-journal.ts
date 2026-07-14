import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  link,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type JournalOperation = "publish" | "push";
export type JournalPhase =
  | "started"
  | "index_staged"
  | "commit_observed"
  | "push_started"
  | "terminal";

export interface JournalRecord {
  schemaVersion: 1;
  requestId: string;
  operation: JournalOperation;
  repoKey: string;
  inputHash: string;
  phase: JournalPhase;
  createdAt: string;
  updatedAt: string;
  result?: unknown;
}

interface BeginJournalInput {
  requestId: string;
  operation: JournalOperation;
  repoKey: string;
  inputHash: string;
}

interface OperationJournalOptions {
  stateRoot?: string;
}

export class IdempotencyConflictError extends Error {
  readonly code = "IDEMPOTENCY_CONFLICT";

  constructor(requestId: string) {
    super(`Request ID was already used with different input: ${requestId}`);
    this.name = "IdempotencyConflictError";
  }
}

const getStateRoot = () =>
  process.env.XDG_STATE_HOME
    ? join(process.env.XDG_STATE_HOME, "usable-git")
    : join(homedir(), ".local", "state", "usable-git");

const validateRequestId = (requestId: string) => {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(requestId)) {
    throw new TypeError(
      "requestId must contain 1-128 letters, numbers, dots, underscores, or hyphens",
    );
  }
};

const journalFileName = (requestId: string) =>
  `${createHash("sha256").update(requestId).digest("hex")}.json`;

const writeDurably = async (path: string, value: JournalRecord) => {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const file = await open(temporaryPath, "wx", 0o600);

  try {
    await file.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }

  try {
    await rename(temporaryPath, path);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await rm(temporaryPath, { force: true });
  }
};

const writeNewDurably = async (path: string, value: JournalRecord) => {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.new`;
  const file = await open(temporaryPath, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }

  try {
    try {
      await link(temporaryPath, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    return true;
  } finally {
    await rm(temporaryPath, { force: true });
  }
};

export const createOperationJournal = (
  options: OperationJournalOptions = {},
) => {
  const stateRoot = options.stateRoot ?? getStateRoot();
  const journalPath = (requestId: string) =>
    join(stateRoot, "journals", journalFileName(requestId));

  const read = async (requestId: string) => {
    validateRequestId(requestId);
    try {
      return JSON.parse(
        await readFile(journalPath(requestId), "utf8"),
      ) as JournalRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };

  const begin = async (input: BeginJournalInput) => {
    validateRequestId(input.requestId);
    const existingOutcome = (existing: JournalRecord) => {
      if (
        existing.operation !== input.operation ||
        existing.repoKey !== input.repoKey ||
        existing.inputHash !== input.inputHash
      ) {
        throw new IdempotencyConflictError(input.requestId);
      }

      if (existing.phase === "terminal") {
        return { kind: "replay" as const, result: existing.result };
      }

      return { kind: "resume" as const, record: existing };
    };
    const existing = await read(input.requestId);
    if (existing) return existingOutcome(existing);

    const now = new Date().toISOString();
    const record: JournalRecord = {
      schemaVersion: 1,
      ...input,
      phase: "started",
      createdAt: now,
      updatedAt: now,
    };
    const created = await writeNewDurably(journalPath(input.requestId), record);
    if (!created) {
      const concurrent = await read(input.requestId);
      if (!concurrent) throw new Error("Concurrent journal creation produced no readable record");
      return existingOutcome(concurrent);
    }
    return { kind: "started" as const, record };
  };

  const transition = async (requestId: string, phase: JournalPhase) => {
    const existing = await read(requestId);
    if (!existing) throw new Error(`Unknown request ID: ${requestId}`);
    const next: JournalRecord = {
      ...existing,
      phase,
      updatedAt: new Date().toISOString(),
    };
    await writeDurably(journalPath(requestId), next);
    return next;
  };

  const complete = async (requestId: string, result: unknown) => {
    const existing = await read(requestId);
    if (!existing) throw new Error(`Unknown request ID: ${requestId}`);
    const next: JournalRecord = {
      ...existing,
      phase: "terminal",
      result,
      updatedAt: new Date().toISOString(),
    };
    await writeDurably(journalPath(requestId), next);
    return next;
  };

  return { begin, transition, complete, read };
};
