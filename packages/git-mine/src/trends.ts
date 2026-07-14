import { EpisodeData } from "./episodes";

export interface ShapeStats {
  shape: string;
  count: number;
  medianLlmOps: number;
  medianOutputTokens: number;
  failureRate: number;
  category: "read-bundle" | "publish-chain" | "other";
  intents: string[];
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const half = Math.floor(sorted.length / 2);
  if (sorted.length % 2 !== 0) {
    return sorted[half]!;
  }
  return (sorted[half - 1]! + sorted[half]!) / 2.0;
}

const READ_BUNDLE_SET = new Set([
  "status",
  "diff",
  "log",
  "show",
  "rev-parse",
  "branch",
  "remote",
  "cat-file",
  "config"
]);

export function deriveCategory(shape: string): "read-bundle" | "publish-chain" | "other" {
  const subcommands = shape.split(">").filter(Boolean);
  if (subcommands.length === 0) return "other";

  // Check read-bundle
  const isReadBundle = subcommands.every(sub => READ_BUNDLE_SET.has(sub));
  if (isReadBundle) return "read-bundle";

  // Check publish-chain
  const addIdx = subcommands.indexOf("add");
  if (addIdx !== -1) {
    let validPrefix = true;
    for (let i = 0; i < addIdx; i++) {
      const sub = subcommands[i]!;
      if (sub !== "status" && sub !== "diff") {
        validPrefix = false;
        break;
      }
    }
    if (validPrefix && subcommands[addIdx + 1] === "commit") {
      const remaining = subcommands.slice(addIdx + 2);
      if (remaining.length === 0) {
        return "publish-chain";
      }
      if (remaining.length === 1 && remaining[0] === "push") {
        return "publish-chain";
      }
    }
  }

  return "other";
}

export function calculateTrends(episodes: EpisodeData[]): ShapeStats[] {
  const groups = new Map<string, EpisodeData[]>();

  for (const ep of episodes) {
    const shape = ep.shape || "(empty)";
    if (!groups.has(shape)) {
      groups.set(shape, []);
    }
    groups.get(shape)!.push(ep);
  }

  const statsList: ShapeStats[] = [];

  for (const [shape, eps] of groups.entries()) {
    const count = eps.length;
    const llmOpsList = eps.map(e => e.llm_ops);
    
    // Tokens approximated as output characters / 4
    const tokenList = eps.map(e => {
      const chars = e.steps.reduce((sum, s) => sum + (s.output?.length || 0), 0);
      return Math.round(chars / 4);
    });

    const medianLlmOps = median(llmOpsList);
    const medianOutputTokens = median(tokenList);

    // Failure rate: outcome starts with "failed_" or is "failure", or at least one step had is_error
    const failures = eps.filter(e => {
      const outcomeFail = e.outcome.startsWith("failed_") || e.outcome === "failure";
      const stepFail = e.steps.some(s => s.is_error);
      return outcomeFail || stepFail;
    }).length;

    const failureRate = count > 0 ? (failures / count) * 100 : 0;

    // Prefer human intents over orchestrator ones in samples
    const humanIntents = Array.from(
      new Set(
        eps
          .filter(e => e.intent_source === "human")
          .map(e => e.intent.trim())
          .filter(intent => intent && intent !== "No Intent" && !intent.startsWith("<local-command"))
      )
    );
    const orchestratorIntents = Array.from(
      new Set(
        eps
          .filter(e => e.intent_source !== "human")
          .map(e => e.intent.trim())
          .filter(intent => intent && intent !== "No Intent" && !intent.startsWith("<local-command"))
      )
    );

    const combinedIntents = [...humanIntents];
    for (const o of orchestratorIntents) {
      if (combinedIntents.length >= 3) break;
      if (!combinedIntents.includes(o)) {
        combinedIntents.push(o);
      }
    }
    const finalIntents = combinedIntents.slice(0, 3);

    const category = deriveCategory(shape);

    statsList.push({
      shape,
      count,
      medianLlmOps,
      medianOutputTokens,
      failureRate,
      category,
      intents: finalIntents.length > 0 ? finalIntents : ["No specific intent"],
    });
  }

  // Sort by count descending, then by medianLlmOps descending
  return statsList.sort((a, b) => b.count - a.count || b.medianLlmOps - a.medianLlmOps);
}

export function generateTrendsMarkdown(episodes: EpisodeData[]): string {
  const stats = calculateTrends(episodes);

  let md = "## Git Episode Mining Trends Report\n\n";
  md += `Total episodes analyzed: **${episodes.length}**\n\n`;

  md += "| Rank | Shape | Count | Med Ops | Med Tokens | Fail Rate | Category | Sample Intents |\n";
  md += "|---|---|---|---|---|---|---|---|\n";

  let rank = 1;
  for (const s of stats.slice(0, 20)) {
    const intentsStr = s.intents.map(i => `"${i.replace(/\r?\n/g, " ").slice(0, 50)}"`).join("<br>");
    md += `| ${rank} | \`${s.shape}\` | ${s.count} | ${s.medianLlmOps} | ${s.medianOutputTokens} | ${s.failureRate.toFixed(1)}% | ${s.category} | ${intentsStr} |\n`;
    rank++;
  }

  return md;
}
