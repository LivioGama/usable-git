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
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  ]) {
    delete environment[key];
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
