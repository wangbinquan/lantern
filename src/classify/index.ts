/**
 * Read-only vs mutating command classifier — lanternd's defense-in-depth layer
 * (design.md §6 "第 2 层"). Applied to the free-form remote command that the
 * agent supplies to `lantern exec --cmd`. The auto-allowed read subcommands
 * (`logs`/`state`/`snapshot`) do NOT go through this — they are read-only by
 * construction (fixed templates).
 *
 * Approach mirrors Claude Code's classifier (design.md §4 借鉴):
 *  - split a compound command on shell operators; EVERY segment must be read-only
 *  - strip only safe wrappers (timeout/nice/nohup/…)
 *  - command/process substitution, write-redirection, unknown binary, or a known
 *    mutating verb  =>  mutating
 *  - catastrophic patterns  =>  deny (hard block)
 *  - anything not provably read-only defaults to MUTATING (fail-safe → ask)
 *
 * The verdict is advisory triage; the human confirmation gate (opencode
 * `permissions`) remains the real boundary.
 */

export type Verdict = "read" | "mutate" | "deny";

export interface ClassifyResult {
  verdict: Verdict;
  /** Short human-readable reason (used in audit + surfaced to the operator). */
  reason: string;
}

export interface ProprietaryReadOnly {
  binary: string;
  /** Read-only verbs; omit/empty ⇒ the whole binary is read-only. */
  verbs?: string[];
}

export interface ClassifyOptions {
  /**
   * Proprietary env CLIs and their KNOWN read-only verbs (maintained by the
   * platform/ops team — design.md §6). Default: none, so any unrecognized
   * proprietary binary is treated as mutating (fail-safe).
   */
  proprietaryReadOnly?: ProprietaryReadOnly[];
}

/** Catastrophic patterns — hard `deny` regardless of anything else. */
const CATASTROPHIC: { re: RegExp; reason: string }[] = [
  { re: /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/i, reason: "rm -rf" },
  { re: /\bmkfs(\.\w+)?\b/i, reason: "filesystem format (mkfs)" },
  { re: /\bdd\b[^|;&]*\bof=\/dev\/(sd|nvme|disk|hd)/i, reason: "dd to a raw block device" },
  { re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: "fork bomb" },
  { re: /\b(shutdown|reboot|halt|poweroff)\b/i, reason: "host power state change" },
  { re: /\binit\s+[06]\b/i, reason: "init runlevel change" },
  { re: />\s*\/dev\/(sd|nvme|disk|hd)/i, reason: "redirect to a raw block device" },
  { re: /\bchmod\s+-R\s+0*0{3}\s+\//i, reason: "chmod -R 000 /" },
];

/** Safe leading wrappers that can be stripped without changing read/write nature. */
const SAFE_WRAPPERS = new Set(["timeout", "nice", "nohup", "stdbuf", "time", "ionice", "chrt"]);

/** Binaries that are read-only no matter the arguments (no in-place/write flags). */
const READONLY_BINARIES = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "stat",
  "file",
  "du",
  "df",
  "pwd",
  "echo",
  "printf",
  "date",
  "uname",
  "hostname",
  "id",
  "whoami",
  "groups",
  "uptime",
  "free",
  "ps",
  "env",
  "printenv",
  "grep",
  "egrep",
  "fgrep",
  "zgrep",
  "zcat",
  "which",
  "whereis",
  "type",
  "readlink",
  "realpath",
  "dirname",
  "basename",
  "uniq",
  "cut",
  "tr",
  "od",
  "xxd",
  "hexdump",
  "strings",
  "tac",
  "nl",
  "column",
  "jq",
  "yq",
  "true",
  "test",
  "[",
  "comm",
  "join",
  "paste",
  "fold",
  "expand",
  "rev",
  "cksum",
  "md5sum",
  "sha1sum",
  "sha256sum",
  "lsof",
  "netstat",
  "ss",
  "vmstat",
  "iostat",
  "journalctl",
  "dmesg",
  "jstack",
  "jmap",
  "jps",
  "jinfo",
]);

/** Binaries whose recognized verb decides read-only-ness. */
const SUBCOMMAND_READONLY: Record<string, Set<string>> = {
  git: new Set([
    "status",
    "log",
    "diff",
    "show",
    "branch",
    "tag",
    "remote",
    "rev-parse",
    "describe",
    "blame",
    "cat-file",
    "ls-files",
    "ls-tree",
    "shortlog",
    "reflog",
    "config",
    "whatchanged",
  ]),
  kubectl: new Set([
    "get",
    "describe",
    "logs",
    "top",
    "explain",
    "api-resources",
    "api-versions",
    "version",
    "events",
    "cluster-info",
    "config",
    "auth",
  ]),
  helm: new Set(["list", "ls", "status", "get", "history", "show", "search", "version", "env"]),
  docker: new Set([
    "ps",
    "images",
    "image",
    "inspect",
    "logs",
    "top",
    "stats",
    "version",
    "info",
    "port",
    "history",
    "events",
  ]),
  podman: new Set([
    "ps",
    "images",
    "image",
    "inspect",
    "logs",
    "top",
    "stats",
    "version",
    "info",
    "port",
    "history",
  ]),
  systemctl: new Set([
    "status",
    "show",
    "list-units",
    "list-unit-files",
    "is-active",
    "is-enabled",
    "is-failed",
    "cat",
    "get-default",
  ]),
  // Arthas read-only batch commands. The invasive ones (watch/trace/tt/monitor/
  // stack/profiler) and the mutating ones (redefine/ognl/…) are NOT here — they
  // route through `lantern observe`/`redefine` (ask), not a read path.
  arthas: new Set([
    "dashboard",
    "thread",
    "jvm",
    "sysprop",
    "sysenv",
    "getstatic",
    "sc",
    "sm",
    "jad",
  ]),
};

/** Verbs that always run arbitrary/mutating work even on a read-capable binary. */
const ALWAYS_MUTATING_VERBS: Record<string, Set<string>> = {
  kubectl: new Set([
    "exec",
    "cp",
    "attach",
    "port-forward",
    "proxy",
    "run",
    "debug",
    "edit",
    "apply",
    "delete",
    "create",
    "patch",
    "scale",
    "drain",
    "cordon",
    "uncordon",
    "label",
    "annotate",
    "set",
    "rollout",
    "replace",
    "taint",
    "expose",
  ]),
  docker: new Set([
    "run",
    "exec",
    "rm",
    "rmi",
    "build",
    "start",
    "stop",
    "restart",
    "kill",
    "cp",
    "commit",
    "push",
    "pull",
    "tag",
    "create",
    "rename",
    "update",
    "prune",
  ]),
  systemctl: new Set([
    "start",
    "stop",
    "restart",
    "reload",
    "enable",
    "disable",
    "mask",
    "unmask",
    "set-default",
    "isolate",
    "kill",
  ]),
  arthas: new Set([
    "redefine",
    "retransform",
    "reset",
    "ognl",
    "vmtool",
    "heapdump",
    "watch",
    "trace",
    "stack",
    "tt",
    "monitor",
    "profiler",
  ]),
};

const SHELL_SPLIT_RE = /(\|\||&&|;|\|&|\||&|\n)/;

/** Split a compound command into segments on shell control operators. */
export function splitSegments(cmd: string): string[] {
  return cmd
    .split(SHELL_SPLIT_RE)
    .filter((s) => !SHELL_SPLIT_RE.test(s))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Strip leading safe wrappers + env-var assignments; return the inner command. */
export function stripWrappers(segment: string): string {
  let tokens = segment.split(/\s+/).filter(Boolean);
  let changed = true;
  while (changed && tokens.length > 0) {
    changed = false;
    while (tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]!)) {
      tokens = tokens.slice(1);
      changed = true;
    }
    if (tokens.length === 0) break;
    const head = tokens[0]!;
    if (head === "env") {
      tokens = tokens.slice(1);
      changed = true;
      continue;
    }
    if (SAFE_WRAPPERS.has(head)) {
      tokens = tokens.slice(1);
      while (tokens.length > 0 && tokens[0]!.startsWith("-")) {
        const flag = tokens[0]!;
        tokens = tokens.slice(1);
        if (/^-[sn]$/.test(flag) && tokens.length > 0 && !tokens[0]!.startsWith("-")) {
          tokens = tokens.slice(1);
        }
      }
      if (head === "timeout" && tokens.length > 0 && /^\d+(\.\d+)?[smhd]?$/.test(tokens[0]!)) {
        tokens = tokens.slice(1);
      }
      changed = true;
    }
  }
  return tokens.join(" ");
}

/** Does the command contain substitution / process-substitution / write-redirection? */
function hasDangerousShell(cmd: string): { bad: boolean; reason: string } {
  if (/\$\(/.test(cmd) || /`/.test(cmd)) return { bad: true, reason: "command substitution" };
  if (/<\(|>\(/.test(cmd)) return { bad: true, reason: "process substitution" };
  // write redirection to a real file (allow 2>/dev/null, >/dev/null, >&N, 2>&1)
  if (/(^|\s)\d*>>?\s*(?!&|\/dev\/null\b)\S/.test(cmd))
    return { bad: true, reason: "write redirection" };
  if (/&>/.test(cmd) && !/&>\s*\/dev\/null\b/.test(cmd))
    return { bad: true, reason: "write redirection" };
  return { bad: false, reason: "" };
}

/** First token (after head) that is a recognized verb in any of the given sets. */
function knownVerb(tokens: string[], sets: (Set<string> | undefined)[]): string | undefined {
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.startsWith("-")) continue;
    for (const s of sets) if (s?.has(t)) return t;
  }
  return undefined;
}

/** Classify a single (already wrapper-stripped) segment. */
function classifySegment(segment: string, opts: ClassifyOptions): ClassifyResult {
  const tokens = segment.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { verdict: "read", reason: "empty segment" };
  const head = tokens[0]!;

  if (head === "sudo" || head === "su") return { verdict: "mutate", reason: `${head} escalation` };

  for (const p of opts.proprietaryReadOnly ?? []) {
    if (head !== p.binary) continue;
    if (!p.verbs || p.verbs.length === 0)
      return { verdict: "read", reason: `${head} (read-only CLI)` };
    const v = knownVerb(tokens, [new Set(p.verbs)]);
    return v
      ? { verdict: "read", reason: `${head} ${v} (read-only verb)` }
      : { verdict: "mutate", reason: `${head} not a read-only verb` };
  }

  if (READONLY_BINARIES.has(head)) return { verdict: "read", reason: `${head} (read-only)` };

  const mut = ALWAYS_MUTATING_VERBS[head];
  const sub = SUBCOMMAND_READONLY[head];
  if (mut || sub) {
    const v = knownVerb(tokens, [mut, sub]);
    if (!v) return { verdict: "mutate", reason: `${head} (no recognized read-only verb)` };
    if (mut?.has(v)) return { verdict: "mutate", reason: `${head} ${v} (mutating verb)` };
    if (head === "kubectl" && (v === "config" || v === "auth")) {
      const sv = tokens[tokens.indexOf(v) + 1];
      const ok = v === "config" ? "view" : "can-i";
      if (sv && sv !== ok) return { verdict: "mutate", reason: `kubectl ${v} non-read` };
    }
    return { verdict: "read", reason: `${head} ${v} (read-only)` };
  }

  // binaries that are read-only only without their write flags
  if (head === "find") {
    return /(^|\s)-(exec|execdir|delete|ok|okdir|fprintf?|fls|fprint)\b/.test(segment)
      ? { verdict: "mutate", reason: "find -exec/-delete" }
      : { verdict: "read", reason: "find (read-only)" };
  }
  if (head === "sed") {
    return /(^|\s)-[a-z]*i/.test(segment)
      ? { verdict: "mutate", reason: "sed -i writes in place" }
      : { verdict: "read", reason: "sed (no -i)" };
  }
  if (head === "sort") {
    return /(^|\s)(-o\b|--output)/.test(segment)
      ? { verdict: "mutate", reason: "sort -o writes a file" }
      : { verdict: "read", reason: "sort (read-only)" };
  }
  if (head === "awk" || head === "gawk" || head === "mawk") {
    return { verdict: "mutate", reason: "awk can exec/system()" };
  }

  return { verdict: "mutate", reason: `unknown binary "${head}" (default-ask)` };
}

/** Classify a full (possibly compound) remote command. */
export function classifyCommand(cmd: string, opts: ClassifyOptions = {}): ClassifyResult {
  const trimmed = cmd.trim();
  if (trimmed.length === 0) return { verdict: "mutate", reason: "empty command" };

  for (const c of CATASTROPHIC) {
    if (c.re.test(trimmed)) return { verdict: "deny", reason: c.reason };
  }

  const danger = hasDangerousShell(trimmed);
  if (danger.bad) return { verdict: "mutate", reason: danger.reason };

  const segments = splitSegments(trimmed);
  if (segments.length === 0) return { verdict: "mutate", reason: "no command segments" };

  const reasons: string[] = [];
  for (const seg of segments) {
    const res = classifySegment(stripWrappers(seg), opts);
    if (res.verdict !== "read") return res;
    reasons.push(res.reason);
  }
  return { verdict: "read", reason: reasons.join("; ") };
}
