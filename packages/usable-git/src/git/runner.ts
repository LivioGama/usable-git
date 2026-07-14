export type GitRunResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  processCount: 1;
};

export type GitSpawnEvent = {
  argv: string[];
  cwd: string;
};

export type GitRunnerOptions = {
  onSpawn?: (event: GitSpawnEvent) => void;
};

type GitMetrics = { gitSubprocessCount: number };
const operationMetrics = new AsyncLocalStorage<GitMetrics>();

export const withGitMetrics = async <T>(operation: () => Promise<T>) => {
  const metrics: GitMetrics = { gitSubprocessCount: 0 };
  const result = await operationMetrics.run(metrics, operation);
  return { result, gitSubprocessCount: metrics.gitSubprocessCount };
};

export class GitCommandError extends Error {
  readonly argv: string[];
  readonly cwd: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;

  constructor(event: GitSpawnEvent, result: GitRunResult) {
    super(result.stderr.trim() || `git exited with status ${result.exitCode}`);
    this.name = "GitCommandError";
    this.argv = event.argv;
    this.cwd = event.cwd;
    this.exitCode = result.exitCode;
    this.stdout = result.stdout;
    this.stderr = result.stderr;
  }
}

const gitEnvironment = () => {
  const environment = { ...process.env };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_CONFIG",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_SYSTEM",
    "GIT_CONFIG_NOSYSTEM",
    "GIT_DIFF_OPTS",
    "GIT_EXTERNAL_DIFF",
  ]) {
    delete environment[key];
  }
  for (const key of Object.keys(environment)) {
    if (
      key === "GIT_CONFIG_COUNT" ||
      key.startsWith("GIT_CONFIG_KEY_") ||
      key.startsWith("GIT_CONFIG_VALUE_")
    ) {
      delete environment[key];
    }
  }

  return {
    ...environment,
    LC_ALL: "C",
    LANG: "C",
    PAGER: "cat",
    GIT_PAGER: "cat",
    GIT_EXTERNAL_DIFF: "",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_LAZY_FETCH: "1",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    GIT_LITERAL_PATHSPECS: "1",
  };
};

export const createGitRunner = (options: GitRunnerOptions = {}) => ({
  run: async (cwd: string, args: string[], input?: Uint8Array): Promise<GitRunResult> => {
    const argv = [
      "git",
      "--no-pager",
      "-c",
      "color.ui=false",
      "-c",
      "core.pager=cat",
      "-c",
      "diff.external=",
      ...args,
    ];
    const event = { argv, cwd };
    const metrics = operationMetrics.getStore();
    if (metrics) metrics.gitSubprocessCount += 1;
    options.onSpawn?.(event);
    const child = Bun.spawn(argv, {
      cwd,
      env: gitEnvironment(),
      stdin: input ? new Blob([input]) : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const result: GitRunResult = {
      stdout,
      stderr,
      exitCode,
      processCount: 1,
    };

    return result;
  },
  runChecked: async (cwd: string, args: string[], input?: Uint8Array) => {
    const argv = [
      "git",
      "--no-pager",
      "-c",
      "color.ui=false",
      "-c",
      "core.pager=cat",
      "-c",
      "diff.external=",
      ...args,
    ];
    const event = { argv, cwd };
    const runner = createGitRunner(options);
    const result = await runner.run(cwd, args, input);
    if (result.exitCode !== 0) {
      throw new GitCommandError(event, result);
    }
    return result;
  },
});

export type GitRunner = ReturnType<typeof createGitRunner>;

export const git = createGitRunner();
import { AsyncLocalStorage } from "node:async_hooks";
