import { createHash } from "node:crypto";
import { z } from "zod";
import { UsableGitError } from "../errors.ts";

const hexDigestSchema = z.string().regex(/^[a-f0-9]{40,64}$/);
const offsetSchema = z.union([
  z.number().int().nonnegative(),
  z.record(z.string(), z.number().int().nonnegative()),
]);

const payloadSchema = z.object({
  version: z.literal(1),
  operation: z.enum(["review", "history"]),
  requestDigest: hexDigestSchema,
  snapshot: hexDigestSchema,
  offset: offsetSchema,
});

const wireSchema = z.object({
  payload: payloadSchema,
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
});

export type CursorPayload = z.infer<typeof payloadSchema>;
export type CursorInput = Omit<CursorPayload, "version">;

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
};

export const digestValue = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");

export const encodeCursor = (input: CursorInput) => {
  const payload = payloadSchema.parse({ version: 1, ...input });
  const wire = { payload, checksum: digestValue(payload) };
  return Buffer.from(JSON.stringify(wire)).toString("base64url");
};

export const decodeCursor = (
  encoded: string,
  operation: CursorPayload["operation"],
): CursorPayload => {
  try {
    const wire = wireSchema.parse(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
    if (wire.checksum !== digestValue(wire.payload)) throw new Error("checksum mismatch");
    if (wire.payload.operation !== operation) throw new Error("operation mismatch");
    return wire.payload;
  } catch (error) {
    if (error instanceof UsableGitError) throw error;
    throw new UsableGitError("INVALID_INPUT", "Invalid pagination cursor");
  }
};
