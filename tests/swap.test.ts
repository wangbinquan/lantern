import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Artifact,
  dispatch,
  type DispatchDeps,
  EventBus,
  previewSwap,
  SessionPool,
  type SwapRun,
  uploadArtifact,
  type WatchEvent,
} from "../src/daemon";
import type { ServiceDescriptor, SwapRecipe } from "../src/types";
import { spawnPty } from "../src/pty";
import { Registry } from "../src/registry";
import type { EnvDescriptor } from "../src/types";

const localFactory = () => () => spawnPty(["bash", "--norc", "--noprofile"]);

function artifactOf(content: Buffer): Artifact {
  return {
    bytes: content.length,
    base64: content.toString("base64"),
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

function fakeRun(checksumHex: string | null, opts: { decodeExit?: number } = {}): SwapRun {
  return (cmd) => {
    if (cmd.includes("sha256sum") || cmd.includes("shasum")) {
      return Promise.resolve({
        stdout: checksumHex ? `${checksumHex}  /remote\n` : "(none)",
        exitCode: 0,
      });
    }
    if (cmd.startsWith("{ base64 -d")) {
      return Promise.resolve({ stdout: "", exitCode: opts.decodeExit ?? 0 });
    }
    return Promise.resolve({ stdout: "", exitCode: 0 });
  };
}

describe("uploadArtifact (RFC-0003 slice 2)", () => {
  const art = artifactOf(Buffer.from("abc"));

  test("verifies a matching remote checksum", async () => {
    const sha = await uploadArtifact(fakeRun(art.sha256), art, "/app/x", {
      tmpPath: "/tmp/u",
      chunkSize: 2,
    });
    expect(sha).toBe(art.sha256);
  });
  test("throws on checksum mismatch (so swap won't restart)", async () => {
    await expect(
      uploadArtifact(fakeRun("b".repeat(64)), art, "/app/x", { tmpPath: "/t" }),
    ).rejects.toThrow(/checksum mismatch/);
  });
  test("throws on remote decode failure", async () => {
    await expect(
      uploadArtifact(fakeRun(art.sha256, { decodeExit: 1 }), art, "/app/x", { tmpPath: "/t" }),
    ).rejects.toThrow(/decode failed/);
  });
  test("throws when the checksum is unreadable", async () => {
    await expect(uploadArtifact(fakeRun(null), art, "/app/x", { tmpPath: "/t" })).rejects.toThrow(
      /could not read remote checksum/,
    );
  });

  test("on mismatch: never moves into place, discards staging (H-3 atomicity)", async () => {
    const cmds: string[] = [];
    const run: SwapRun = (cmd) => {
      cmds.push(cmd);
      if (cmd.includes("sha256sum") || cmd.includes("shasum")) {
        return Promise.resolve({ stdout: `${"b".repeat(64)}  /x\n`, exitCode: 0 });
      }
      return Promise.resolve({ stdout: "", exitCode: 0 });
    };
    await expect(
      uploadArtifact(run, art, "/app/x.jar", { tmpPath: "/t", stagingSuffix: "test" }),
    ).rejects.toThrow(/mismatch/);
    expect(cmds.some((c) => c.startsWith("mv "))).toBe(false); // live path untouched
    expect(cmds.some((c) => c.includes("rm -f '/app/x.jar.lantern.test.new'"))).toBe(true); // staging cleaned
  });

  test("a verified upload moves staging → remotePath (H-3)", async () => {
    const cmds: string[] = [];
    const run: SwapRun = (cmd) => {
      cmds.push(cmd);
      if (cmd.includes("sha256sum") || cmd.includes("shasum")) {
        return Promise.resolve({ stdout: `${art.sha256}  /x\n`, exitCode: 0 });
      }
      return Promise.resolve({ stdout: "", exitCode: 0 });
    };
    await uploadArtifact(run, art, "/app/x.jar", { tmpPath: "/t", stagingSuffix: "test" });
    expect(cmds).toContain("mv '/app/x.jar.lantern.test.new' '/app/x.jar'");
  });

  test("uses a UNIQUE staging path per upload (concurrent-safe)", async () => {
    const paths = new Set<string>();
    const recordingRun = (): SwapRun => (cmd) => {
      const m = /^mv '([^']+)'/.exec(cmd);
      if (m) paths.add(m[1]!);
      if (cmd.includes("sha256sum") || cmd.includes("shasum")) {
        return Promise.resolve({ stdout: `${art.sha256}  /x\n`, exitCode: 0 });
      }
      return Promise.resolve({ stdout: "", exitCode: 0 });
    };
    await uploadArtifact(recordingRun(), art, "/app/x.jar", { tmpPath: "/t" });
    await uploadArtifact(recordingRun(), art, "/app/x.jar", { tmpPath: "/t" });
    expect(paths.size).toBe(2); // distinct staging paths → no clobber between swaps
  });
});

describe("put round-trip through the session (LOCAL_SHELL integration)", () => {
  function envWith(remotePath: string): EnvDescriptor {
    return {
      id: "e",
      form: "proprietary",
      bastion: { host: "h", loginUser: "me", auth: { type: "password", secretRef: "x" } },
      services: [{ name: "svc", runtime: "jvm", swap: { mode: "manual", remotePath } }],
    };
  }

  test("uploads, decodes, and checksum-verifies a real (binary) artifact", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lantern-swap-"));
    const artifactPath = join(dir, "art.bin");
    const remotePath = join(dir, "deployed.bin");
    // include non-printable bytes + enough length to span multiple chunks
    const content = Buffer.concat([
      Buffer.from("LANTERN-SWAP "),
      Buffer.from([0, 1, 2, 254, 255]),
      Buffer.from("y".repeat(4000)),
    ]);
    writeFileSync(artifactPath, content);
    const registry = new Registry(":memory:");
    registry.upsertEnv(envWith(remotePath));
    const pool = new SessionPool(registry, localFactory);
    const deps: DispatchDeps = { registry, pool };
    try {
      const r = await dispatch(deps, {
        id: 1,
        method: "put",
        params: { envId: "e", service: "svc", file: artifactPath, chunkSize: 512 },
      });
      expect(r.ok).toBe(true);
      expect(readFileSync(remotePath)).toEqual(content);
    } finally {
      await pool.releaseAll();
      registry.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("backs up an existing remotePath before overwriting", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lantern-swap2-"));
    const artifactPath = join(dir, "art.bin");
    const remotePath = join(dir, "deployed.bin");
    writeFileSync(remotePath, Buffer.from("OLD-CONTENT"));
    const newContent = Buffer.from("NEW-CONTENT-123");
    writeFileSync(artifactPath, newContent);
    const registry = new Registry(":memory:");
    registry.upsertEnv(envWith(remotePath));
    const pool = new SessionPool(registry, localFactory);
    try {
      const r = await dispatch(
        { registry, pool },
        {
          id: 1,
          method: "put",
          params: { envId: "e", service: "svc", file: artifactPath },
        },
      );
      expect(r.ok).toBe(true);
      const payload = r.ok ? (r.result as { backedUp: boolean }) : { backedUp: false };
      expect(payload.backedUp).toBe(true);
      expect(readFileSync(remotePath)).toEqual(newContent);
      expect(readFileSync(`${remotePath}.lantern.bak`)).toEqual(Buffer.from("OLD-CONTENT"));
    } finally {
      await pool.releaseAll();
      registry.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("previewSwap (RFC-0003 dry-run)", () => {
  const svc = (swap: SwapRecipe): ServiceDescriptor => ({ name: "svc", runtime: "jvm", swap });
  const art = artifactOf(Buffer.from("y".repeat(5000)));

  test("computes the plan without running anything", () => {
    const p = previewSwap(
      svc({
        mode: "manual",
        remotePath: "/app/x.jar",
        restartCmd: "systemctl restart x",
        healthCmd: "true",
      }),
      art,
    );
    expect(p).toMatchObject({
      remotePath: "/app/x.jar",
      backupPath: "/app/x.jar.lantern.bak",
      restartCmd: "systemctl restart x",
      healthCmd: "true",
      rollback: true,
      sha256: art.sha256,
      artifactBytes: 5000,
    });
    expect(p.chunkCount).toBeGreaterThan(0);
  });

  test("rejects a non-read-only healthCmd", () => {
    expect(() =>
      previewSwap(
        svc({ mode: "manual", remotePath: "/x", restartCmd: "r", healthCmd: "rm -rf /tmp/x" }),
        art,
      ),
    ).toThrow(/read-only/);
    // H-2: a no-space write redirect must also be caught
    expect(() =>
      previewSwap(
        svc({ mode: "manual", remotePath: "/x", restartCmd: "r", healthCmd: "echo ok>/tmp/pwned" }),
        art,
      ),
    ).toThrow(/read-only/);
  });

  test("requires remotePath + restartCmd", () => {
    expect(() => previewSwap(svc({ mode: "manual", restartCmd: "r" }), art)).toThrow(/remotePath/);
    expect(() => previewSwap(svc({ mode: "manual", remotePath: "/x" }), art)).toThrow(/restartCmd/);
  });
});

describe("swap + restart orchestration (LOCAL_SHELL integration)", () => {
  function envSwap(swap: SwapRecipe): EnvDescriptor {
    return {
      id: "e",
      form: "proprietary",
      bastion: { host: "h", loginUser: "me", auth: { type: "password", secretRef: "x" } },
      services: [{ name: "svc", runtime: "jvm", swap }],
    };
  }

  test("healthy swap: uploads, restarts, passes health → swapped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lantern-swapok-"));
    const artifactPath = join(dir, "art.bin");
    const remotePath = join(dir, "deployed.bin");
    const content = Buffer.from("HEALTHY-PAYLOAD-123");
    writeFileSync(artifactPath, content);
    const registry = new Registry(":memory:");
    registry.upsertEnv(
      envSwap({ mode: "manual", remotePath, restartCmd: "echo restarted", healthCmd: "true" }),
    );
    const pool = new SessionPool(registry, localFactory);
    try {
      const r = await dispatch(
        { registry, pool },
        {
          id: 1,
          method: "swap",
          params: { envId: "e", service: "svc", file: artifactPath, chunkSize: 256 },
        },
      );
      expect(r.ok).toBe(true);
      const res = r.ok
        ? (r.result as { swapped: boolean; rolledBack: boolean; healthExit: number })
        : null;
      expect(res?.swapped).toBe(true);
      expect(res?.rolledBack).toBe(false);
      expect(res?.healthExit).toBe(0);
      expect(readFileSync(remotePath)).toEqual(content);
    } finally {
      await pool.releaseAll();
      registry.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("unhealthy swap: rolls back to the backup + restarts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lantern-swaprb-"));
    const artifactPath = join(dir, "art.bin");
    const remotePath = join(dir, "deployed.bin");
    writeFileSync(remotePath, Buffer.from("OLD-GOOD"));
    writeFileSync(artifactPath, Buffer.from("NEW-BROKEN"));
    const registry = new Registry(":memory:");
    registry.upsertEnv(
      // health `test 1 = 2` is read-only and exits 1 → unhealthy
      envSwap({ mode: "manual", remotePath, restartCmd: "echo r", healthCmd: "test 1 = 2" }),
    );
    const pool = new SessionPool(registry, localFactory);
    try {
      const r = await dispatch(
        { registry, pool },
        {
          id: 1,
          method: "swap",
          params: { envId: "e", service: "svc", file: artifactPath },
        },
      );
      expect(r.ok).toBe(true);
      const res = r.ok ? (r.result as { swapped: boolean; rolledBack: boolean }) : null;
      expect(res?.swapped).toBe(false);
      expect(res?.rolledBack).toBe(true);
      expect(readFileSync(remotePath)).toEqual(Buffer.from("OLD-GOOD")); // restored
    } finally {
      await pool.releaseAll();
      registry.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a broken restartCmd reports restarted=false + rollbackError (H-4)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lantern-swaph4-"));
    const artifactPath = join(dir, "art.bin");
    const remotePath = join(dir, "deployed.bin");
    writeFileSync(remotePath, Buffer.from("OLD"));
    writeFileSync(artifactPath, Buffer.from("NEW"));
    const registry = new Registry(":memory:");
    // restartCmd `false` always exits 1 → restart fails, and the rollback restart fails too
    registry.upsertEnv(
      envSwap({ mode: "manual", remotePath, restartCmd: "false", healthCmd: "true" }),
    );
    const pool = new SessionPool(registry, localFactory);
    try {
      const r = await dispatch(
        { registry, pool },
        {
          id: 1,
          method: "swap",
          params: { envId: "e", service: "svc", file: artifactPath },
        },
      );
      expect(r.ok).toBe(true);
      const res = r.ok
        ? (r.result as {
            swapped: boolean;
            restarted: boolean;
            rolledBack: boolean;
            rollbackError?: string;
          })
        : null;
      expect(res?.swapped).toBe(false); // never healthy → CLI exits non-zero
      expect(res?.restarted).toBe(false); // not assumed-true (H-4)
      expect(res?.rolledBack).toBe(false); // rollback's restart also failed
      expect(res?.rollbackError).toContain("bad state");
      expect(readFileSync(remotePath)).toEqual(Buffer.from("OLD")); // cp still restored the artifact
    } finally {
      await pool.releaseAll();
      registry.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("swap publishes the actual backup/upload/restart commands to the watch bus (M-1)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lantern-swapm1-"));
    const artifactPath = join(dir, "art.bin");
    const remotePath = join(dir, "deployed.bin");
    writeFileSync(artifactPath, Buffer.from("PAYLOAD"));
    const registry = new Registry(":memory:");
    registry.upsertEnv(
      envSwap({ mode: "manual", remotePath, restartCmd: "echo r", healthCmd: "true" }),
    );
    const bus = new EventBus();
    const events: WatchEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const pool = new SessionPool(registry, localFactory, {}, bus);
    try {
      await dispatch(
        { registry, pool, bus },
        {
          id: 1,
          method: "swap",
          params: { envId: "e", service: "svc", file: artifactPath },
        },
      );
      const cmds = events.flatMap((e) =>
        e.kind === "command" && e.method === "swap" ? [e.command] : [],
      );
      expect(cmds.some((c) => c.includes("[backup] cp"))).toBe(true);
      expect(cmds.some((c) => c.includes("[upload] base64"))).toBe(true);
      expect(cmds.some((c) => c.includes("[restart] echo r"))).toBe(true);
      expect(cmds.some((c) => c.includes("[health] true"))).toBe(true);
    } finally {
      await pool.releaseAll();
      registry.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuses a swap while the service lock is held, releases it after (per-service lock)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lantern-lock-"));
    const artifactPath = join(dir, "art.bin");
    const remotePath = join(dir, "deployed.bin");
    writeFileSync(artifactPath, Buffer.from("X"));
    const registry = new Registry(":memory:");
    registry.upsertEnv(
      envSwap({ mode: "manual", remotePath, restartCmd: "echo r", healthCmd: "true" }),
    );
    const pool = new SessionPool(registry, localFactory);
    const locks = new Set<string>(["e/svc"]); // pre-held (simulates an in-flight swap)
    const deps: DispatchDeps = { registry, pool, locks };
    const swapReq = {
      id: 1,
      method: "swap" as const,
      params: { envId: "e", service: "svc", file: artifactPath },
    };
    try {
      const blocked = await dispatch(deps, swapReq);
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) expect(blocked.error).toContain("in progress");

      locks.delete("e/svc"); // the in-flight swap finished
      const r = await dispatch(deps, swapReq);
      expect(r.ok).toBe(true);
      expect(locks.has("e/svc")).toBe(false); // lock released after the swap
    } finally {
      await pool.releaseAll();
      registry.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("restart runs the service's restartCmd", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lantern-restart-"));
    const registry = new Registry(":memory:");
    registry.upsertEnv(
      envSwap({ mode: "manual", remotePath: join(dir, "x"), restartCmd: "echo restarted-ok" }),
    );
    const pool = new SessionPool(registry, localFactory);
    try {
      const r = await dispatch(
        { registry, pool },
        {
          id: 1,
          method: "restart",
          params: { envId: "e", service: "svc" },
        },
      );
      expect(r.ok).toBe(true);
      const res = r.ok ? (r.result as { exitCode: number; stdout: string }) : null;
      expect(res?.exitCode).toBe(0);
      expect(res?.stdout).toContain("restarted-ok");
    } finally {
      await pool.releaseAll();
      registry.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
