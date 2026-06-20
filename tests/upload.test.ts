import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseChecksum, planUpload, readArtifact } from "../src/daemon";

describe("planUpload (RFC-0003 slice 1)", () => {
  test("truncates then appends chunks of the given size", () => {
    const plan = planUpload({
      base64: "ABCDEFGHIJ",
      remotePath: "/app/x",
      tmpPath: "/tmp/u",
      chunkSize: 4,
    });
    expect(plan.chunkCount).toBe(3);
    expect(plan.appendCommands).toEqual([
      ": > '/tmp/u'",
      "printf %s 'ABCD' >> '/tmp/u'",
      "printf %s 'EFGH' >> '/tmp/u'",
      "printf %s 'IJ' >> '/tmp/u'",
    ]);
  });

  test("decode + checksum are GNU/BSD portable; paths shell-quoted", () => {
    const plan = planUpload({ base64: "AA==", remotePath: "/a b/x.jar", tmpPath: "/tmp/u" });
    expect(plan.decodeCommand).toBe(
      "{ base64 -d < '/tmp/u' > '/a b/x.jar' 2>/dev/null || base64 -D < '/tmp/u' > '/a b/x.jar' ; }",
    );
    expect(plan.checksumCommand).toBe(
      "{ sha256sum '/a b/x.jar' 2>/dev/null || shasum -a 256 '/a b/x.jar' ; }",
    );
    expect(plan.cleanupCommand).toBe("rm -f '/tmp/u'");
  });

  test("default chunk size handles an empty payload (just truncate)", () => {
    const plan = planUpload({ base64: "", remotePath: "/x", tmpPath: "/t" });
    expect(plan.chunkCount).toBe(0);
    expect(plan.appendCommands).toEqual([": > '/t'"]);
  });

  test("rejects a non-positive chunk size", () => {
    expect(() =>
      planUpload({ base64: "AA", remotePath: "/x", tmpPath: "/t", chunkSize: 0 }),
    ).toThrow();
  });

  test("a NaN chunk size falls back to the default (L-1)", () => {
    const plan = planUpload({
      base64: "AAAAAAAA",
      remotePath: "/x",
      tmpPath: "/t",
      chunkSize: Number.NaN,
    });
    expect(plan.chunkCount).toBe(1); // 16384 default → one chunk, not a broken plan
  });
});

describe("parseChecksum", () => {
  test("extracts the hex digest from sha256sum / shasum output", () => {
    const hex = "a".repeat(64);
    expect(parseChecksum(`${hex}  /app/x.jar\n`)).toBe(hex);
    expect(parseChecksum(`SHA256(/x)= ${hex}`)).toBe(hex);
    expect(parseChecksum("no digest here")).toBeNull();
  });
});

describe("readArtifact (local IO)", () => {
  test("reads bytes, base64, and sha256", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lantern-art-"));
    const path = join(dir, "a.bin");
    const content = Buffer.from("hello-artifact-123");
    writeFileSync(path, content);
    try {
      const art = await readArtifact(path);
      expect(art.bytes).toBe(content.length);
      expect(art.base64).toBe(content.toString("base64"));
      expect(art.sha256).toBe(createHash("sha256").update(content).digest("hex"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("throws when the artifact is missing", async () => {
    await expect(readArtifact("/no/such/artifact.bin")).rejects.toThrow(/not found/);
  });
});
