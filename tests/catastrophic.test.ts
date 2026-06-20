import { describe, expect, test } from "bun:test";
import { catastrophicReason } from "../src/safety/catastrophic";

describe("catastrophicReason (RFC-0005 backstop)", () => {
  test("flags clearly-destructive commands", () => {
    expect(catastrophicReason("rm -rf /")).toContain("rm -rf");
    expect(catastrophicReason("rm -r -f /tmp/x")).toContain("rm -rf");
    expect(catastrophicReason("rm --recursive --force /")).toContain("rm -rf");
    expect(catastrophicReason("ls && rm -fr /data")).toContain("rm -rf");
    expect(catastrophicReason("mkfs.ext4 /dev/sda1")).toContain("mkfs");
    expect(catastrophicReason("dd if=/dev/zero of=/dev/sda")).toContain("dd");
    expect(catastrophicReason("shutdown -h now")).toContain("power");
    expect(catastrophicReason(":(){ :|:& };:")).toContain("fork bomb");
  });

  test("normalizes cheap obfuscations (empty quotes / backslashes) before matching", () => {
    expect(catastrophicReason('r""m -rf /')).toContain("rm -rf");
    expect(catastrophicReason("r''m -rf /data")).toContain("rm -rf");
    expect(catastrophicReason('m""kfs.ext4 /dev/sda')).toContain("mkfs");
    expect(catastrophicReason("rm\\ -rf /data")).toContain("rm -rf"); // backslash-escaped space
  });

  test("allows normal commands (incl. non-recursive rm)", () => {
    expect(catastrophicReason("tail -n 100 /app/log")).toBeNull();
    expect(catastrophicReason("rm /tmp/x")).toBeNull();
    expect(catastrophicReason("rm -r /tmp/x")).toBeNull(); // recursive but not forced
    expect(catastrophicReason("grep ERROR app.log")).toBeNull();
    expect(catastrophicReason("kubectl get pods")).toBeNull();
  });
});
