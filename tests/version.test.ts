import { expect, test } from "bun:test";
import { VERSION } from "../src/version";

test("VERSION is a semver-ish string", () => {
  expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
});
