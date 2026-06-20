import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rpc } from "../src/cli/client";
import {
  defaultAuditPath,
  defaultRegistryDbPath,
  defaultSocketPath,
  fileAuditSink,
  SessionPool,
} from "../src/daemon";
import { spawnPty } from "../src/pty";
import { Registry } from "../src/registry";
import type { EnvDescriptor } from "../src/types";

describe("fileAuditSink", () => {
  test("creates the dir and appends JSONL entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "lantern-audit-"));
    const path = join(dir, "nested", "audit.jsonl");
    try {
      const sink = fileAuditSink(path);
      sink({ ts: 1, envId: "e", method: "exec", command: "echo", exitCode: 0, stdoutBytes: 3 });
      sink({ ts: 2, envId: "e", method: "logs", command: "tail", exitCode: 0, stdoutBytes: 9 });
      const lines = readFileSync(path, "utf8").trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]!)).toMatchObject({ ts: 1, method: "exec" });
      expect(JSON.parse(lines[1]!)).toMatchObject({ ts: 2, method: "logs" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("paths", () => {
  test("honor LANTERN_HOME", () => {
    const prevHome = process.env.LANTERN_HOME;
    const prevSock = process.env.LANTERN_SOCK;
    delete process.env.LANTERN_SOCK;
    process.env.LANTERN_HOME = "/tmp/lh";
    try {
      expect(defaultSocketPath()).toBe("/tmp/lh/lanternd.sock");
      expect(defaultAuditPath()).toBe("/tmp/lh/audit.jsonl");
      expect(defaultRegistryDbPath()).toBe("/tmp/lh/registry.db");
    } finally {
      if (prevHome === undefined) delete process.env.LANTERN_HOME;
      else process.env.LANTERN_HOME = prevHome;
      if (prevSock !== undefined) process.env.LANTERN_SOCK = prevSock;
    }
  });

  test("LANTERN_SOCK overrides the socket path", () => {
    const prev = process.env.LANTERN_SOCK;
    process.env.LANTERN_SOCK = "/tmp/custom.sock";
    try {
      expect(defaultSocketPath()).toBe("/tmp/custom.sock");
    } finally {
      if (prev === undefined) delete process.env.LANTERN_SOCK;
      else process.env.LANTERN_SOCK = prev;
    }
  });
});

describe("SessionPool lifecycle", () => {
  const localFactory = () => () =>
    spawnPty(["bash", "--norc", "--noprofile"], {
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "/tmp" },
    });

  function registryWithEnv(): Registry {
    const r = new Registry(":memory:");
    const env: EnvDescriptor = {
      id: "p",
      form: "proprietary",
      bastion: { host: "h", loginUser: "l", auth: { type: "password", secretRef: "x" } },
    };
    r.upsertEnv(env);
    return r;
  }

  test("has / get (memoized) / release / releaseAll", async () => {
    const pool = new SessionPool(registryWithEnv(), localFactory);
    expect(pool.has("p")).toBe(false);
    const s = pool.get("p"); // lazy — no shell spawned until run()
    expect(pool.has("p")).toBe(true);
    expect(pool.get("p")).toBe(s); // same instance memoized
    await pool.release("p");
    expect(pool.has("p")).toBe(false);
    pool.get("p");
    await pool.releaseAll();
    expect(pool.has("p")).toBe(false);
  });
});

describe("rpc client error handling", () => {
  test("rejects when the socket does not exist", async () => {
    await expect(
      rpc("/tmp/lantern-does-not-exist.sock", { id: 1, method: "ping" }, 2000),
    ).rejects.toBeDefined();
  });
});

describe("registry file permissions (Codex H7)", () => {
  test("dir is 0700 and db is 0600", () => {
    const dir = mkdtempSync(join(tmpdir(), "lantern-perm-"));
    const sub = join(dir, "store");
    const path = join(sub, "registry.db");
    try {
      const r = new Registry(path);
      r.close();
      expect(statSync(sub).mode & 0o777).toBe(0o700);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
