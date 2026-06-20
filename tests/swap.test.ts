import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Artifact,
  dispatch,
  type DispatchDeps,
  SessionPool,
  type SwapRun,
  uploadArtifact,
} from "../src/daemon";
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
