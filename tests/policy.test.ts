import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { evaluatePermission, loadPermissions } from "../src/opencode";

const RULES = loadPermissions(join(import.meta.dir, "..", ".opencode", "opencode.json"));
const v = (action: string, resource: string) => evaluatePermission(RULES, action, resource);

describe(".opencode/opencode.json hardened ruleset", () => {
  test("read tools auto-allow", () => {
    expect(v("read", "/etc/anything")).toBe("allow");
    expect(v("grep", "x")).toBe("allow");
    expect(v("glob", "x")).toBe("allow");
    expect(v("list", "x")).toBe("allow");
  });

  test("read-only lantern subcommands allow (auto-run, still shown)", () => {
    expect(v("bash", "lantern logs --service order-svc --tail 100")).toBe("allow");
    expect(v("bash", "lantern state --service order-svc")).toBe("allow");
    expect(v("bash", "lantern snapshot --service order-svc")).toBe("allow");
    expect(v("bash", "lantern env list")).toBe("allow");
    expect(v("bash", "lantern env current")).toBe("allow");
  });

  test("mutating subcommands + bare bash + edit/write => ask", () => {
    expect(v("bash", "lantern exec --env e -- echo hi")).toBe("ask");
    expect(v("bash", "lantern env use env-A")).toBe("ask");
    expect(v("bash", "lantern observe --service x")).toBe("ask");
    expect(v("bash", "lantern redefine --service x")).toBe("ask");
    expect(v("bash", "echo hi")).toBe("ask");
    expect(v("edit", "f")).toBe("ask");
    expect(v("write", "f")).toBe("ask");
  });

  test("shell chaining/substitution => deny, even after an allowed prefix (deny wins)", () => {
    expect(v("bash", "lantern logs --service x && rm -rf /")).toBe("deny");
    expect(v("bash", "lantern logs --service x ; cat /etc/passwd")).toBe("deny");
    expect(v("bash", "cat $(whoami)")).toBe("deny");
    expect(v("bash", "echo `id`")).toBe("deny");
    expect(v("bash", "diff <(ls) <(ls)")).toBe("deny");
    expect(v("bash", "echo ${HOME}")).toBe("deny");
    expect(v("bash", "rm -rf /tmp/x")).toBe("deny");
    expect(v("bash", "sudo ls")).toBe("deny");
    expect(v("bash", "ssh host")).toBe("deny");
  });

  test("pipe/redirect fall to ask (human review), not deny", () => {
    expect(v("bash", "lantern logs --service x --grep 'a|b'")).toBe("ask");
    expect(v("bash", "echo x > /tmp/f")).toBe("ask");
  });

  test("credential path unreadable; code repos can be approved", () => {
    expect(v("external_directory", "/Users/me/.lantern/registry.db")).toBe("deny");
    expect(v("external_directory", "/Users/me/code/order-svc")).toBe("ask");
  });

  test("default is ask for anything unmatched (fail-safe)", () => {
    expect(v("some_unknown_tool", "whatever")).toBe("ask");
  });
});

describe("evaluatePermission semantics", () => {
  test("deny wins regardless of order", () => {
    const rules = [
      { action: "bash", resource: "*", effect: "allow" as const },
      { action: "bash", resource: "*danger*", effect: "deny" as const },
    ];
    expect(evaluatePermission(rules, "bash", "do danger now")).toBe("deny");
  });
  test("findLast among allow/ask", () => {
    const rules = [
      { action: "bash", resource: "*", effect: "allow" as const },
      { action: "bash", resource: "git *", effect: "ask" as const },
    ];
    expect(evaluatePermission(rules, "bash", "git push")).toBe("ask");
    expect(evaluatePermission(rules, "bash", "ls")).toBe("allow");
  });
});
