import { historyRequestSchema, type HistoryRequest } from "../contracts/v1.ts";
import { requireWorktreeRepository } from "../git/repository.ts";
import { git } from "../git/runner.ts";

export type HistoryCommit = {
  oid: string;
  parents: string[];
  author: { name: string; email: string };
  authoredAt: string;
  signatureStatus: string;
  message: string;
};

export type HistoryResult = {
  commits: HistoryCommit[];
  bytes: number;
  nextCursor?: string;
};

const encodeCursor = (skip: number) => Buffer.from(JSON.stringify({ skip })).toString("base64url");

const decodeCursor = (value: string | undefined) => {
  if (!value) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { skip?: number };
    if (!Number.isInteger(parsed.skip) || (parsed.skip ?? -1) < 0) throw new Error("invalid");
    return parsed.skip!;
  } catch {
    throw new Error("Invalid history cursor");
  }
};

export const parseHistory = (output: string): HistoryCommit[] => {
  const fields = output.split("\0");
  const commits: HistoryCommit[] = [];
  let index = 0;
  while (index < fields.length) {
    while (fields[index] === "") index += 1;
    if (index >= fields.length) break;
    const oid = fields[index++];
    const parents = fields[index++];
    const name = fields[index++];
    const email = fields[index++];
    const authoredAt = fields[index++];
    const signatureStatus = fields[index++];
    const message = fields[index++];
    if (
      oid === undefined ||
      parents === undefined ||
      name === undefined ||
      email === undefined ||
      authoredAt === undefined ||
      signatureStatus === undefined ||
      message === undefined
    ) {
      throw new Error("Malformed NUL-delimited git history");
    }
    commits.push({
      oid,
      parents: parents ? parents.split(" ") : [],
      author: { name, email },
      authoredAt,
      signatureStatus,
      message,
    });
  }
  return commits;
};

export const history = async (input: HistoryRequest): Promise<HistoryResult> => {
  const request = historyRequestSchema.parse(input);
  const repository = await requireWorktreeRepository(request.repoPath);
  const skip = decodeCursor(request.cursor);
  const exists = await git.run(repository.root, ["rev-parse", "--verify", "--quiet", request.ref]);
  if (exists.exitCode === 1 && request.ref === "HEAD") return { commits: [], bytes: 0 };
  if (exists.exitCode !== 0) throw new Error(exists.stderr.trim() || `Unknown revision: ${request.ref}`);

  const result = await git.runChecked(repository.root, [
    "log",
    `--max-count=${request.limit + 1}`,
    `--skip=${skip}`,
    "-z",
    "--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%G?%x00%B%x00",
    "--end-of-options",
    request.ref,
  ]);
  const parsed = parseHistory(result.stdout);
  const hasMoreByCount = parsed.length > request.limit;
  const candidates = parsed.slice(0, request.limit);
  const byteCap = request.byteCap ?? 256_000;
  const commits: HistoryCommit[] = [];
  let bytes = 0;
  for (const commit of candidates) {
    const commitBytes = Buffer.byteLength(JSON.stringify(commit));
    if (bytes + commitBytes > byteCap) {
      if (commits.length === 0) throw new Error("A commit exceeds the history response byte cap");
      break;
    }
    commits.push(commit);
    bytes += commitBytes;
  }
  const hasMore = hasMoreByCount || commits.length < candidates.length;
  return {
    commits,
    bytes,
    ...(hasMore ? { nextCursor: encodeCursor(skip + commits.length) } : {}),
  };
};
