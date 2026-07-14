import { createV1McpEnvelopeSchema, type operationSchema } from "../v1.ts";
import { historyResultSchema } from "./history.ts";
import { inspectResultSchema } from "./inspect.ts";
import { publishResultSchema } from "./publish.ts";
import { pushResultSchema } from "./push.ts";
import { reviewResultSchema } from "./review.ts";
import type { z } from "zod";

export const operationResultSchemas = {
  inspect: inspectResultSchema,
  review: reviewResultSchema,
  history: historyResultSchema,
  publish: publishResultSchema,
  push: pushResultSchema,
} as const;

export const operationMcpOutputSchemas = {
  inspect: createV1McpEnvelopeSchema("inspect", inspectResultSchema),
  review: createV1McpEnvelopeSchema("review", reviewResultSchema),
  history: createV1McpEnvelopeSchema("history", historyResultSchema),
  publish: createV1McpEnvelopeSchema("publish", publishResultSchema),
  push: createV1McpEnvelopeSchema("push", pushResultSchema),
} as const;

export const parseOperationResult = (
  operation: z.infer<typeof operationSchema>,
  result: unknown,
) => operationResultSchemas[operation].parse(result);
