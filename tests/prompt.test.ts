import { describe, expect, test } from "bun:test";
import { ask, type Asker, confirm, v } from "../src/cli/prompt";

function scripted(answers: string[]): Asker {
  let i = 0;
  return () => Promise.resolve(answers[i++] ?? "");
}

describe("ask (RFC-0002 slice 3)", () => {
  test("returns the default on empty input", async () => {
    expect(await ask(scripted([""]), "Port", { default: "22" })).toBe("22");
  });
  test("trims input", async () => {
    expect(await ask(scripted(["  ops  "]), "User")).toBe("ops");
  });
  test("retries until the validator passes", async () => {
    const a = await ask(scripted(["bad host!", "good-host"]), "Host", { validate: v.host });
    expect(a).toBe("good-host");
  });
});

describe("confirm", () => {
  test("parses y/yes/n and honors the default", async () => {
    expect(await confirm(scripted(["y"]), "ok?")).toBe(true);
    expect(await confirm(scripted(["yes"]), "ok?")).toBe(true);
    expect(await confirm(scripted(["n"]), "ok?")).toBe(false);
    expect(await confirm(scripted([""]), "ok?", true)).toBe(true);
    expect(await confirm(scripted([""]), "ok?", false)).toBe(false);
  });
});

describe("validators", () => {
  test("username / host / port", () => {
    expect(v.username("ops")).toBeNull();
    expect(v.username("a;rm -rf /")).not.toBeNull();
    expect(v.host("10.0.0.1")).toBeNull();
    expect(v.host("h$(id)")).not.toBeNull();
    expect(v.port("22")).toBeNull();
    expect(v.port("70000")).not.toBeNull();
    expect(v.nonEmpty("")).not.toBeNull();
    expect(v.nonEmpty("x")).toBeNull();
  });
});
