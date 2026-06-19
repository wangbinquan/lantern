/**
 * Capstone e2e: the WHOLE stack composed over a real unix socket —
 *   rpc client -> Daemon (NDJSON) -> dispatch -> SessionPool -> SessionManager
 *   -> login + su escalation (fake su/ssh fixtures) -> marker'd command
 *   -> classify + audit
 * This is the closest in-CI analogue of opencode's bash calling `lantern …`
 * against a real isolated environment.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rpc } from "../src/cli/client";
import { type AuditEntry, Daemon, SessionPool } from "../src/daemon";
import type { RpcResponse, RunResultPayload } from "../src/daemon";
import { spawnPty } from "../src/pty";
import { Registry } from "../src/registry";
import type { EnvDescriptor } from "../src/types";

const FIX = `${import.meta.dir}/fixtures/bin`;
const WHOAMI = `printf '%s\\n' "$LANTERN_WHO"`;

describe("e2e: full stack over the socket with su escalation", () => {
  test("daemon drives login->su, runs as the escalated user, classifies + audits", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lantern-e2e-"));
    const socketPath = join(dir, "d.sock");

    const registry = new Registry(":memory:");
    const env: EnvDescriptor = {
      id: "envE",
      form: "proprietary",
      bastion: { host: "h", loginUser: "low", auth: { type: "password", secretRef: "low" } },
      escalate: [{ type: "su", user: "high", secretRef: "high" }],
      services: [{ name: "svc", runtime: "jvm", locate: { pid: "echo 7" } }],
    };
    registry.upsertEnv(env);
    registry.setSecret("high", "pw-high");

    const pool = new SessionPool(
      registry,
      () => () =>
        spawnPty(["bash", "--norc", "--noprofile"], {
          env: {
            PATH: `${FIX}:${process.env.PATH ?? ""}`,
            HOME: process.env.HOME ?? "/tmp",
            LANTERN_WHO: "low",
            LANG: "C",
          },
        }),
      { whoamiCmd: WHOAMI, syncTimeoutMs: 6000, commandTimeoutMs: 6000 },
    );
    const audit: AuditEntry[] = [];
    const daemon = new Daemon({ registry, pool, audit: (e) => audit.push(e) });
    daemon.listen(socketPath);

    try {
      const used = await rpc(socketPath, { id: 1, method: "env.use", params: { id: "envE" } });
      expect(used.ok).toBe(true);

      // A command run after escalation reports the ESCALATED identity ("high"),
      // proving the daemon walked login -> su over the real session.
      const who = (await rpc(socketPath, {
        id: 2,
        method: "exec",
        params: { command: "echo $LANTERN_WHO" },
      })) as RpcResponse<RunResultPayload>;
      expect(who.ok).toBe(true);
      if (who.ok) {
        expect(who.result.stdout).toBe("high");
        expect(who.result.verdict).toBe("read");
        expect(who.result.exitCode).toBe(0);
      }

      // Read-only state subcommand (read-only by construction).
      const st = (await rpc(socketPath, {
        id: 3,
        method: "state",
        params: { service: "svc" },
      })) as RpcResponse<RunResultPayload>;
      expect(st.ok).toBe(true);
      if (st.ok) expect(st.result.stdout.trim()).toBe("7");

      // Catastrophic command refused by the lanternd backstop.
      const bad = await rpc(socketPath, {
        id: 4,
        method: "exec",
        params: { command: "rm -rf /tmp/x" },
      });
      expect(bad.ok).toBe(false);

      // Audit captured both the read exec and the denied one.
      expect(audit.some((a) => a.method === "exec" && a.verdict === "read")).toBe(true);
      expect(audit.some((a) => a.verdict === "deny")).toBe(true);
    } finally {
      daemon.stop();
      await pool.releaseAll();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
