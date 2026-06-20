/**
 * Interactive prompt helpers for `lantern env init` (RFC-0002 §4.3). The
 * validate/default/retry logic (`ask`, `confirm`) is decoupled from terminal I/O
 * via an injectable `Asker`, so it is unit-tested without a TTY; `makeTtyAsker`
 * is the thin glue (readline + muted echo for secrets), smoke-tested.
 *
 * Prompts go to STDERR so stdout stays clean.
 */
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

export type Asker = (question: string, opts: { secret?: boolean }) => Promise<string>;

export interface AskOpts {
  default?: string;
  secret?: boolean;
  /** Return an error message to re-prompt, or null if the value is acceptable. */
  validate?: (value: string) => string | null;
}

/** Ask once, applying default + validation, retrying until valid. */
export async function ask(asker: Asker, question: string, opts: AskOpts = {}): Promise<string> {
  for (;;) {
    const suffix = opts.default !== undefined ? ` (${opts.default})` : "";
    const raw = (await asker(`${question}${suffix}: `, { secret: opts.secret })).trim();
    const value = raw.length === 0 && opts.default !== undefined ? opts.default : raw;
    const err = opts.validate?.(value);
    if (err) {
      process.stderr.write(`  ✗ ${err}\n`);
      continue;
    }
    return value;
  }
}

/** Yes/no with a default. */
export async function confirm(asker: Asker, question: string, def = false): Promise<boolean> {
  const raw = (await asker(`${question} [${def ? "Y/n" : "y/N"}]: `, {})).trim().toLowerCase();
  if (raw === "") return def;
  return raw === "y" || raw === "yes";
}

/** Field validators — mirror the registry schema regexes (the schema is the real backstop). */
export const v = {
  nonEmpty: (s: string): string | null => (s.trim().length === 0 ? "required" : null),
  username: (s: string): string | null =>
    /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(s) ? null : "invalid username (no shell metacharacters)",
  host: (s: string): string | null =>
    /^[A-Za-z0-9_.:-]+$/.test(s) ? null : "invalid host (letters/digits/.:-_ only)",
  port: (s: string): string | null =>
    /^\d+$/.test(s) && Number(s) > 0 && Number(s) < 65536 ? null : "invalid port",
};

/** Real terminal asker: one readline, with muted echo for secret prompts. */
export function makeTtyAsker(): { ask: Asker; close: () => void } {
  const out = new (class extends Writable {
    muted = false;
    override _write(chunk: Buffer, _enc: BufferEncoding, cb: () => void): void {
      if (!this.muted) process.stderr.write(chunk);
      cb();
    }
  })();
  const rl = createInterface({ input: process.stdin, output: out, terminal: true });
  rl.on("SIGINT", () => {
    process.stderr.write("\n");
    process.exit(130);
  });
  const asker: Asker = async (question, opts) => {
    if (!opts.secret) return rl.question(question);
    const answer = rl.question(question);
    out.muted = true; // hide what's typed for the password
    try {
      return await answer;
    } finally {
      out.muted = false;
      process.stderr.write("\n"); // the Enter wasn't echoed
    }
  };
  return { ask: asker, close: () => rl.close() };
}
