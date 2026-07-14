import { resolve } from "node:path";
import { decodeCursor, digestValue, encodeCursor } from "../contracts/cursor.ts";
import { reviewRequestSchema, type ReviewRequest } from "../contracts/v1.ts";
import { UsableGitError } from "../errors.ts";
import { fingerprintChange } from "../git/fingerprint.ts";
import { validateLiteralFiles } from "../git/paths.ts";
import { requireWorktreeRepository } from "../git/repository.ts";
import { git } from "../git/runner.ts";
import { parsePorcelainV2, type StatusChange } from "../git/status.ts";

export type ReviewScope = "staged" | "unstaged" | "untracked";

export type ReviewItem = {
  scope: ReviewScope;
  path: string;
  originalPath?: string;
  patch: string;
  binary: boolean;
  additions: number;
  deletions: number;
  truncated: boolean;
};

export type ReviewResult = {
  items: ReviewItem[];
  bytes: number;
  nextCursor?: string;
};

type Cursor = { item: number; character: number };

const statistics = (patch: string) => {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { additions, deletions };
};

const diffItem = async (
  root: string,
  change: StatusChange,
  scope: Exclude<ReviewScope, "untracked">,
): Promise<ReviewItem> => {
  const args = ["diff", "--no-ext-diff", "--no-textconv", "--binary"];
  if (scope === "staged") args.push("--cached");
  args.push("--", change.path);
  const result = await git.runChecked(root, args);
  const binary = result.stdout.includes("GIT binary patch") || result.stdout.includes("Binary files ");
  return {
    scope,
    path: change.path,
    ...(change.originalPath === undefined ? {} : { originalPath: change.originalPath }),
    patch: result.stdout,
    binary,
    ...statistics(result.stdout),
    truncated: false,
  };
};

const untrackedItem = async (root: string, path: string): Promise<ReviewItem> => {
  const bytes = new Uint8Array(await Bun.file(resolve(root, path)).arrayBuffer());
  const binary = bytes.includes(0);
  const contents = binary ? "" : new TextDecoder().decode(bytes);
  const patch = binary
    ? `Binary untracked file ${JSON.stringify(path)}\n`
    : `--- /dev/null\n+++ ${JSON.stringify(path)}\n${contents
        .split("\n")
        .map((line, index, lines) => (index === lines.length - 1 && line === "" ? "" : `+${line}`))
        .filter(Boolean)
        .join("\n")}\n`;
  return {
    scope: "untracked",
    path,
    patch,
    binary,
    additions: binary ? 0 : contents.split("\n").filter((_, index, lines) => index < lines.length - 1 || lines[index] !== "").length,
    deletions: 0,
    truncated: false,
  };
};

const sliceWithinBytes = (value: string, character: number, cap: number) => {
  let end = character;
  let bytes = 0;
  for (const codePoint of value.slice(character)) {
    const size = Buffer.byteLength(codePoint);
    if (bytes + size > cap) break;
    bytes += size;
    end += codePoint.length;
  }
  return { value: value.slice(character, end), end, bytes };
};

const paginate = (
  items: ReviewItem[],
  cursor: Cursor,
  byteCap: number,
  requestDigest: string,
  snapshot: string,
) => {
  if (cursor.item > items.length || (cursor.item === items.length && cursor.character !== 0)) {
    throw new Error("Invalid review cursor");
  }
  const selected: ReviewItem[] = [];
  let bytes = 0;
  let itemIndex = cursor.item;
  let character = cursor.character;

  while (itemIndex < items.length && bytes < byteCap) {
    const item = items[itemIndex]!;
    if (character > item.patch.length) throw new Error("Invalid review cursor");
    const slice = sliceWithinBytes(item.patch, character, byteCap - bytes);
    if (slice.end === character && item.patch.length > character) break;
    const complete = slice.end === item.patch.length;
    selected.push({ ...item, patch: slice.value, truncated: !complete });
    bytes += slice.bytes;
    if (!complete) {
      character = slice.end;
      break;
    }
    itemIndex += 1;
    character = 0;
  }

  const hasMore = itemIndex < items.length;
  return {
    items: selected,
    bytes,
    ...(hasMore
      ? {
          nextCursor: encodeCursor({
            operation: "review",
            requestDigest,
            snapshot,
            offset: { item: itemIndex, character },
          }),
        }
      : {}),
  };
};

const changedInIndex = ({ indexStatus, conflicted }: StatusChange) =>
  !conflicted && ![".", " ", "?", "!"].includes(indexStatus);

const changedInWorktree = ({ worktreeStatus, conflicted }: StatusChange) =>
  !conflicted && ![".", " ", "?", "!"].includes(worktreeStatus);

export const review = async (input: ReviewRequest): Promise<ReviewResult> => {
  const request = reviewRequestSchema.parse(input);
  const repository = await requireWorktreeRepository(request.repoPath);
  const files = request.files
    ? await validateLiteralFiles(repository.root, request.files)
    : undefined;
  const requestDigest = digestValue({
    repoPath: repository.root,
    files: files ?? null,
    byteCap: request.byteCap,
  });
  const cursorPayload = request.cursor ? decodeCursor(request.cursor, "review") : undefined;
  if (cursorPayload && cursorPayload.requestDigest !== requestDigest) {
    throw new UsableGitError("INVALID_INPUT", "Cursor belongs to a different review request");
  }
  const args = ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"];
  if (files) args.push("--", ...files);
  const statusResult = await git.runChecked(repository.root, args);
  const parsed = parsePorcelainV2(statusResult.stdout);
  const changes = parsed.changes;
  const snapshot = digestValue({
    branch: parsed.branch,
    changes: await Promise.all(
      changes.map(async (change) => ({
        ...change,
        fingerprint: await fingerprintChange(repository.root, change),
      })),
    ),
  });
  if (cursorPayload && cursorPayload.snapshot !== snapshot) {
    throw new UsableGitError("STALE_STATE", "Repository changed after the review cursor was issued");
  }
  const items: ReviewItem[] = [];

  for (const change of changes) {
    if (changedInIndex(change)) items.push(await diffItem(repository.root, change, "staged"));
    if (changedInWorktree(change)) items.push(await diffItem(repository.root, change, "unstaged"));
    if (files && change.kind === "untracked" && files.includes(change.path)) {
      items.push(await untrackedItem(repository.root, change.path));
    }
  }

  const offset = cursorPayload?.offset ?? { item: 0, character: 0 };
  if (
    typeof offset !== "object" ||
    !("item" in offset) ||
    !("character" in offset)
  ) {
    throw new UsableGitError("INVALID_INPUT", "Invalid review cursor offset");
  }
  return paginate(items, offset as Cursor, request.byteCap, requestDigest, snapshot);
};
