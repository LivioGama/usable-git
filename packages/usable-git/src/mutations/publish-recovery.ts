import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

type SerializedIndexSnapshot =
  | { exists: false; checksum: null }
  | {
      exists: true;
      checksum: string;
      bytesBase64: string;
      mode: number;
    };

export type PublishRecoveryState = {
  schemaVersion: 1;
  requestId: string;
  repoKey: string;
  inputHash: string;
  phase: "snapshotted" | "index_staged" | "commit_started";
  preHead: string | null;
  files: string[];
  index: SerializedIndexSnapshot;
  ownedIndexChecksum: string | null;
};

type PublishRecoveryStoreOptions = { stateRoot?: string };

const defaultStateRoot = () =>
  process.env.XDG_STATE_HOME
    ? join(process.env.XDG_STATE_HOME, "usable-git")
    : join(homedir(), ".local", "state", "usable-git");

const fileName = (requestId: string) =>
  `${createHash("sha256").update(requestId).digest("hex")}.json`;

const writeDurably = async (path: string, state: PublishRecoveryState) => {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const file = await open(temporaryPath, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(state)}\n`, "utf8");
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

export const createPublishRecoveryStore = (
  options: PublishRecoveryStoreOptions = {},
) => {
  const root = options.stateRoot ?? defaultStateRoot();
  const pathFor = (requestId: string) =>
    join(root, "publish-recovery", fileName(requestId));

  const read = async (requestId: string): Promise<PublishRecoveryState | null> => {
    try {
      return JSON.parse(
        await readFile(pathFor(requestId), "utf8"),
      ) as PublishRecoveryState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };

  const write = (state: PublishRecoveryState) =>
    writeDurably(pathFor(state.requestId), state);

  const remove = (requestId: string) => rm(pathFor(requestId), { force: true });

  return { read, write, remove };
};
