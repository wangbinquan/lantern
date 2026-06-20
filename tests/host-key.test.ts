import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { fetchHostKeyFingerprint, type Runner } from "../src/cli/host-key";

const blob = (s: string): string => Buffer.from(s).toString("base64");

describe("fetchHostKeyFingerprint (RFC-0002 slice 2)", () => {
  test("computes the hex matching ssh2's hostHash:sha256, plus a SHA256: display", () => {
    const key = blob("fake-host-key");
    const run: Runner = (cmd) =>
      cmd.includes("-t")
        ? { stdout: "", success: true } // no ed25519
        : { stdout: `10.1.2.3 ssh-rsa ${key}\n`, success: true };
    const r = fetchHostKeyFingerprint("10.1.2.3", 22, run);
    const expectedHex = createHash("sha256").update(Buffer.from(key, "base64")).digest("hex");
    expect(r?.hex).toBe(expectedHex);
    expect(r?.display.startsWith("SHA256:")).toBe(true);
    expect(r?.keyType).toBe("ssh-rsa");
  });

  test("prefers ed25519 when the server offers it", () => {
    const run: Runner = (cmd) =>
      cmd.includes("-t")
        ? { stdout: `h ssh-ed25519 ${blob("ed")}\n`, success: true }
        : { stdout: "MUST-NOT-BE-USED", success: true };
    expect(fetchHostKeyFingerprint("h", 22, run)?.keyType).toBe("ssh-ed25519");
  });

  test("skips comment lines", () => {
    const run: Runner = (cmd) =>
      cmd.includes("-t")
        ? { stdout: "", success: true }
        : { stdout: `# h:22 SSH-2.0\nh ssh-rsa ${blob("k")}\n`, success: true };
    expect(fetchHostKeyFingerprint("h", 22, run)?.keyType).toBe("ssh-rsa");
  });

  test("returns null when nothing is offered", () => {
    const run: Runner = () => ({ stdout: "", success: true });
    expect(fetchHostKeyFingerprint("h", 22, run)).toBeNull();
  });
});
