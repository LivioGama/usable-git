#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type HomebrewRelease = {
  version: string;
  url: string;
  sha256: string;
};

type WriteHomebrewFormulaOptions = HomebrewRelease & {
  outputPath: string;
};

const validateRelease = ({ version, url, sha256 }: HomebrewRelease) => {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("version must be semantic without a v prefix");
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error("url must be an absolute HTTPS release artifact URL");
  }
  if (parsedUrl.protocol !== "https:") {
    throw new Error("url must use HTTPS");
  }
  if (!decodeURIComponent(parsedUrl.pathname).includes(version)) {
    throw new Error("url must contain the version");
  }
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error("sha256 must be 64 lowercase hexadecimal characters");
  }
  if (/^0{64}$/.test(sha256)) {
    throw new Error("sha256 cannot be an all-zero placeholder");
  }
};

export const generateHomebrewFormula = (release: HomebrewRelease) => {
  validateRelease(release);
  const { version, url, sha256 } = release;
  return `class UsableGit < Formula
  desc "Safe semantic Git operations for coding agents"
  homepage "https://github.com/LivioGama/usable-git"
  url "${url}"
  version "${version}"
  sha256 "${sha256}"
  license "MIT"

  depends_on "bun"
  depends_on "git"

  def install
    libexec.install Dir["*"]
    (bin/"usable-git").write <<~SH
      #!/bin/bash
      unset ANTHROPIC_API_KEY
      exec "#{Formula["bun"].opt_bin}/bun" "#{libexec}/packages/usable-git/src/cli.ts" "$@"
    SH
  end

  test do
    require "digest"
    require "json"
    require "open3"
    require "timeout"

    executable = (bin/"usable-git").to_s
    git = (Formula["git"].opt_bin/"git").to_s

    Open3.popen3(executable, "mcp") do |stdin, stdout, _stderr, wait_thread|
      begin
        initialize_request = {
          "jsonrpc" => "2.0",
          "id" => 1,
          "method" => "initialize",
          "params" => {
            "protocolVersion" => "2025-06-18",
            "capabilities" => {},
            "clientInfo" => { "name" => "homebrew-test", "version" => "1.0.0" },
          },
        }
        stdin.puts JSON.generate(initialize_request)
        initialized = Timeout.timeout(10) { JSON.parse(stdout.gets) }
        assert_equal 1, initialized.fetch("id")
        assert_equal "usable-git", initialized.fetch("result").fetch("serverInfo").fetch("name")

        stdin.puts JSON.generate({
          "jsonrpc" => "2.0",
          "method" => "notifications/initialized",
        })
        stdin.puts JSON.generate({
          "jsonrpc" => "2.0",
          "id" => 2,
          "method" => "tools/list",
          "params" => {},
        })
        tools = Timeout.timeout(10) { JSON.parse(stdout.gets) }
        names = tools.fetch("result").fetch("tools").map { |tool| tool.fetch("name") }.sort
        assert_equal %w[history inspect publish push review], names
      ensure
        stdin.close unless stdin.closed?
        unless wait_thread.join(1)
          Process.kill("TERM", wait_thread.pid)
          wait_thread.join
        end
      end
    end

    run = lambda do |*arguments|
      stdout, stderr, status = Open3.capture3(executable, *arguments.map(&:to_s))
      assert status.success?, "usable-git failed: #{stderr}#{stdout}"
      JSON.parse(stdout)
    end

    repo = testpath/"repo"
    remote = testpath/"remote.git"
    repo.mkpath
    system git, "-C", repo, "init", "--initial-branch=main"
    system git, "-C", repo, "config", "user.name", "Homebrew Test"
    system git, "-C", repo, "config", "user.email", "brew@example.invalid"
    (repo/"selected.txt").write "before\n"
    (repo/"unrelated.txt").write "clean\n"
    system git, "-C", repo, "add", "--", "selected.txt", "unrelated.txt"
    system git, "-C", repo, "commit", "-m", "seed"

    (repo/"selected.txt").write "after\n"
    (repo/"unrelated.txt").write "preserve this dirty change\n"
    head = shell_output("#{git} -C #{repo} rev-parse HEAD").strip
    fingerprint = Digest::SHA256.file(repo/"selected.txt").hexdigest
    published = run.call(
      "publish", "--json",
      "--repo-path", repo,
      "--file", "selected.txt",
      "--message", "publish selected path",
      "--request-id", "homebrew-publish",
      "--expected-head", head,
      "--expected-fingerprint", "selected.txt=#{fingerprint}",
    )
    assert published.fetch("ok")
    assert_equal ["selected.txt"], published.fetch("result").fetch("committedPaths")
    status_output, status_error, status = Open3.capture3(
      git, "-C", repo.to_s, "status", "--porcelain=v1",
    )
    assert status.success?, status_error
    assert_match " M unrelated.txt", status_output

    system git, "init", "--bare", "--initial-branch=main", remote
    system git, "-C", repo, "remote", "add", "origin", remote
    commit_oid = published.fetch("result").fetch("commitOid")
    pushed = run.call(
      "push", "--json",
      "--repo-path", repo,
      "--remote", "origin",
      "--source-ref", "refs/heads/main",
      "--target-ref", "refs/heads/main",
      "--request-id", "homebrew-push",
      "--expected-source-oid", commit_oid,
      "--mode", "fast-forward",
    )
    assert pushed.fetch("ok")
    remote_oid = shell_output("#{git} --git-dir #{remote} rev-parse refs/heads/main").strip
    assert_equal pushed.fetch("result").fetch("newTargetOid"), remote_oid
    system git, "-C", repo, "fsck", "--strict"
    system git, "--git-dir", remote, "fsck", "--strict"
  end
end
`;
};

export const writeHomebrewFormula = async ({
  outputPath,
  ...release
}: WriteHomebrewFormulaOptions) => {
  const formula = generateHomebrewFormula(release);
  const directory = dirname(outputPath);
  const temporaryPath = `${outputPath}.${randomUUID()}.tmp`;
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(temporaryPath, formula, { encoding: "utf8", mode: 0o644, flag: "wx" });
    await rename(temporaryPath, outputPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
};

const requiredFlag = (args: string[], flag: string) => {
  const index = args.indexOf(flag);
  const value = index === -1 ? undefined : args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} is required`);
  return value;
};

export const runGenerateFormulaCli = async (args = process.argv.slice(2)) => {
  await writeHomebrewFormula({
    version: requiredFlag(args, "--version"),
    url: requiredFlag(args, "--url"),
    sha256: requiredFlag(args, "--sha256"),
    outputPath: requiredFlag(args, "--output"),
  });
};

if (import.meta.main) {
  try {
    await runGenerateFormulaCli();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
