export interface ExtractedCommand {
  raw: string;
  clean: string;
}

/**
 * Splits a compound bash command string on separators (&&, ||, ;, |)
 * while respecting single/double quotes.
 */
export function splitCommands(cmd: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inDoubleQuote = false;
  let inSingleQuote = false;

  for (let i = 0; i < cmd.length; i++) {
    const char = cmd[i]!;

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      current += char;
    } else if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      current += char;
    } else if (!inDoubleQuote && !inSingleQuote) {
      // Check for separators: ;, &&, ||, |
      if (char === ';') {
        parts.push(current);
        current = "";
      } else if (char === '&' && cmd[i + 1] === '&') {
        parts.push(current);
        current = "";
        i++; // skip next &
      } else if (char === '|' && cmd[i + 1] === '|') {
        parts.push(current);
        current = "";
        i++; // skip next |
      } else if (char === '|') {
        parts.push(current);
        current = "";
      } else {
        current += char;
      }
    } else {
      current += char;
    }
  }
  if (current.trim()) {
    parts.push(current);
  }
  return parts.map(p => p.trim()).filter(Boolean);
}

/**
 * Unwraps wrappers like 'rtk', 'sudo', 'env', env var assignments, and 'git -C'.
 */
export function unwrapCommand(cmd: string): string {
  let prev = "";
  let current = cmd.trim();

  while (current !== prev) {
    prev = current;

    // 1. Strip leading "rtk "
    if (current.startsWith("rtk ")) {
      current = current.slice(4).trim();
      continue;
    }

    // 2. Strip leading "sudo "
    if (current.startsWith("sudo ")) {
      current = current.slice(5).trim();
      continue;
    }

    // 3. Strip leading "env "
    if (current.startsWith("env ")) {
      current = current.slice(4).trim();
      continue;
    }

    // 4. Strip leading env var assignments: KEY=val, KEY="val", KEY='val'
    const envMatch = current.match(/^([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"]*)"|'([^']*)'|(\S+))\s*/);
    if (envMatch) {
      current = current.slice(envMatch[0].length).trim();
      continue;
    }

    // 5. Strip git -C option: git -C path, git -C 'path', git -C "path"
    const gitCMatch = current.match(/^git\s+-C\s+(?:"([^"]*)"|'([^']*)'|(\S+))\s*/);
    if (gitCMatch) {
      current = "git " + current.slice(gitCMatch[0].length).trim();
      continue;
    }
  }

  return current;
}

/**
 * Extracts and cleans git commands from a compound bash command.
 */
export function extractGitCommands(fullCommand: string): ExtractedCommand[] {
  const segments = splitCommands(fullCommand);
  const results: ExtractedCommand[] = [];

  for (const seg of segments) {
    const clean = unwrapCommand(seg);
    if (clean === "git" || clean.startsWith("git ")) {
      results.push({
        raw: seg,
        clean,
      });
    }
  }

  return results;
}

/**
 * Normalizes a clean git command to its subcommand, e.g. "git status -s" -> "status".
 */
export function normalizeGitCommand(cmd: string): string {
  const parts = cmd.trim().split(/\s+/);
  if (parts[0] !== "git") {
    return "unknown";
  }
  const sub = parts[1];
  if (!sub) {
    return "git";
  }
  // Strip potential leading/trailing quotes if it was malformed
  return sub.replace(/['"]+/g, "");
}
