import { UnifiedEvent } from "./sources/claude";
import { extractGitCommands, normalizeGitCommand } from "./extract/shell";

export interface EpisodeStep {
  command: string;
  raw_command: string;
  output?: string;
  exit_code?: number;
  is_error?: boolean;
  ts: string;
}

export interface EpisodeData {
  id: string;
  session_id: string;
  intent: string;
  intent_source: string;
  reasoning: string;
  llm_ops: number;
  context_ops: number;
  outcome: string;
  shape: string;
  ts: string;
  tool?: string;
  steps: EpisodeStep[];
}

/**
 * Heuristics to determine the outcome of a git work episode.
 */
export function determineOutcome(steps: EpisodeStep[]): string {
  if (steps.length === 0) return "empty";

  const hasError = steps.some(s => s.is_error);
  const subcommands = steps.map(s => normalizeGitCommand(s.command));

  if (subcommands.includes("push")) {
    const pushStep = steps[subcommands.lastIndexOf("push")]!;
    return pushStep.is_error ? "failed_push" : "push";
  }

  if (subcommands.includes("commit")) {
    const commitStep = steps[subcommands.lastIndexOf("commit")]!;
    return commitStep.is_error ? "failed_commit" : "commit";
  }

  if (subcommands.includes("merge")) {
    const mergeStep = steps[subcommands.lastIndexOf("merge")]!;
    return mergeStep.is_error ? "failed_merge" : "merge";
  }

  if (subcommands.includes("rebase")) {
    const rebaseStep = steps[subcommands.lastIndexOf("rebase")]!;
    return rebaseStep.is_error ? "failed_rebase" : "rebase";
  }

  // Check if it's purely read-only archaeology
  const readOnlySubs = ["status", "diff", "log", "show", "rev-parse", "config", "cat-file"];
  const isReadOnly = subcommands.every(sub => readOnlySubs.includes(sub));
  if (isReadOnly) {
    return "read_only";
  }

  return hasError ? "failure" : "success";
}

const ORCHESTRATOR_PREFIXES = [
  '<task-notification>',
  '<system-reminder>',
  '<command-message>',
  '<local-command',
  'CMUX agent handoff',
  'Base directory for this skill',
  'Caveat:'
];

export function isOrchestratorIntent(text: string): boolean {
  const trimmed = text.trim();
  return ORCHESTRATOR_PREFIXES.some(prefix => trimmed.startsWith(prefix));
}

interface BufferedTurn {
  ops: number;
  thinking: string[];
  text: string[];
}

/**
 * Aggregates a stream of UnifiedEvents into EpisodeData instances.
 */
export async function parseEpisodes(
  events: AsyncIterable<UnifiedEvent>,
  sessionId: string
): Promise<EpisodeData[]> {
  const episodes: EpisodeData[] = [];

  let currentIntent = "";
  let lastHumanIntent = "";
  let currentIntentTs = "";
  let pendingReasoning: string[] = [];
  let pendingOpsCount = 0;

  let activeEpisode: EpisodeData | null = null;
  let nonGitTurnsCount = 0;
  let bufferedTurns: BufferedTurn[] = [];

  // Track tool calls in the active episode to attach output later
  // Maps tool_use_id -> Step indices in the activeEpisode.steps array
  const activeToolSteps = new Map<string, number[]>();

  for await (const event of events) {
    if (event.role === "user") {
      // Close active episode if any (discard buffered turns since they are trailing)
      if (activeEpisode) {
        episodes.push(finalizeEpisode(activeEpisode));
        activeEpisode = null;
      }

      currentIntent = event.text;
      currentIntentTs = event.ts;
      if (!isOrchestratorIntent(event.text)) {
        lastHumanIntent = event.text;
      }

      pendingReasoning = [];
      pendingOpsCount = 0;
      bufferedTurns = [];
      nonGitTurnsCount = 0;
      activeToolSteps.clear();
      continue;
    }

    if (event.role === "tool") {
      // Update step results in active episode
      for (const result of event.tool_results) {
        const stepIndices = activeToolSteps.get(result.tool_use_id);
        if (stepIndices && activeEpisode) {
          const lastIdx = stepIndices[stepIndices.length - 1];
          for (const idx of stepIndices) {
            const step = activeEpisode.steps[idx];
            if (step) {
              step.output = result.content;
              if (idx === lastIdx) {
                step.is_error = result.is_error;
                step.exit_code = result.is_error ? 1 : 0;
              } else {
                step.is_error = false;
                step.exit_code = 0;
              }
            }
          }
        }
      }
      continue;
    }

    if (event.role === "assistant") {
      // Extract git commands
      const gitCommandsInTurn: { raw: string; clean: string; tool_use_id: string }[] = [];
      for (const tc of event.tool_calls) {
        if (tc.name === "Bash" && typeof tc.input?.command === "string") {
          const extracted = extractGitCommands(tc.input.command);
          for (const ext of extracted) {
            gitCommandsInTurn.push({
              raw: ext.raw,
              clean: ext.clean,
              tool_use_id: tc.id,
            });
          }
        }
      }

      // LLM Ops Definition and Cross-Tool Comparability:
      // Claude Code logs write each assistant turn as a single event containing thinking blocks, 
      // output text, and an array of tool calls. Thus, a turn's weight is 1 + tool_calls.length.
      //
      // Codex logs write reasoning, assistant messages, and tool calls (function_calls) as individual, 
      // sequential JSONL response_item lines. In src/sources/codex.ts, we statefully aggregate these 
      // consecutive assistant items into a single UnifiedAssistantEvent before yielding it.
      // This groups reasoning + messages + tool calls of a turn together, and allows us to compute 
      // llm_ops as 1 + tool_calls.length here. This turn aggregation ensures that cross-tool llm_ops 
      // metrics are direct and comparable: both measure the number of LLM invocations/steps 
      // (1 for generation/thought + 1 for each tool call execution/continuation).
      const hasGit = gitCommandsInTurn.length > 0;
      const turnOps = 1 + event.tool_calls.length;

      if (hasGit) {
        // Start episode if not active
        if (!activeEpisode) {
          const episodeId = `${sessionId}_${episodes.length + 1}`;
          activeEpisode = {
            id: episodeId,
            session_id: sessionId,
            intent: lastHumanIntent || currentIntent || "No Intent",
            intent_source: lastHumanIntent ? "human" : "orchestrator",
            reasoning: "",
            llm_ops: 0,
            context_ops: pendingOpsCount,
            outcome: "",
            shape: "",
            ts: currentIntentTs || event.ts,
            steps: [],
          };
          // Clear pending items since we consumed them
          pendingReasoning = [];
          pendingOpsCount = 0;
        }

        // Flush buffered interleaved turns if any
        if (bufferedTurns.length > 0) {
          for (const bt of bufferedTurns) {
            activeEpisode.llm_ops += bt.ops;
            if (bt.thinking.length > 0) {
              activeEpisode.reasoning += (activeEpisode.reasoning ? "\n" : "") + bt.thinking.map(t => `[Thinking] ${t}`).join("\n");
            }
            if (bt.text.length > 0) {
              activeEpisode.reasoning += (activeEpisode.reasoning ? "\n" : "") + bt.text.join("\n");
            }
          }
          bufferedTurns = [];
        }

        // Add turnOps to active episode
        activeEpisode.llm_ops += turnOps;

        // Accumulate reasoning
        if (event.thinking.length > 0) {
          activeEpisode.reasoning += (activeEpisode.reasoning ? "\n" : "") + event.thinking.map(t => `[Thinking] ${t}`).join("\n");
        }
        if (event.text.length > 0) {
          activeEpisode.reasoning += (activeEpisode.reasoning ? "\n" : "") + event.text.join("\n");
        }

        // Add steps
        for (const gc of gitCommandsInTurn) {
          const stepIndex = activeEpisode.steps.length;
          activeEpisode.steps.push({
            command: gc.clean,
            raw_command: gc.raw,
            ts: event.ts,
          });

          if (!activeToolSteps.has(gc.tool_use_id)) {
            activeToolSteps.set(gc.tool_use_id, []);
          }
          activeToolSteps.get(gc.tool_use_id)!.push(stepIndex);
        }

        nonGitTurnsCount = 0;
      } else {
        // No git in this turn
        if (activeEpisode) {
          nonGitTurnsCount++;
          // Close episode if we exceeded >3 non-git turns (so 4 or more)
          if (nonGitTurnsCount > 3) {
            // Discard bufferedTurns (they are trailing)
            episodes.push(finalizeEpisode(activeEpisode));
            activeEpisode = null;
            activeToolSteps.clear();

            // The buffered turns (which are 3 turns) and this 4th turn are now the beginning of a new pre-git context
            pendingOpsCount = bufferedTurns.reduce((sum, b) => sum + b.ops, 0) + turnOps;
            pendingReasoning = [];
            for (const b of bufferedTurns) {
              pendingReasoning.push(...b.thinking.map(t => `[Thinking] ${t}`), ...b.text);
            }
            pendingReasoning.push(...event.thinking.map(t => `[Thinking] ${t}`), ...event.text);
            bufferedTurns = [];
            nonGitTurnsCount = 0;
          } else {
            // Within threshold (<=3), buffer this turn
            bufferedTurns.push({
              ops: turnOps,
              thinking: event.thinking,
              text: event.text
            });
          }
        } else {
          // Accumulate for potential future episode
          pendingOpsCount += turnOps;
          if (event.thinking.length > 0) {
            pendingReasoning.push(...event.thinking.map(t => `[Thinking] ${t}`));
          }
          if (event.text.length > 0) {
            pendingReasoning.push(...event.text);
          }
        }
      }
    }
  }

  // Finalize last active episode
  if (activeEpisode) {
    // Discard bufferedTurns (they are trailing)
    episodes.push(finalizeEpisode(activeEpisode));
  }

  return episodes;
}

function finalizeEpisode(episode: EpisodeData): EpisodeData {
  episode.outcome = determineOutcome(episode.steps);
  episode.shape = episode.steps
    .map(s => normalizeGitCommand(s.command))
    .filter(Boolean)
    .join(">");
  return episode;
}
