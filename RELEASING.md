# Releasing Lantern

Lantern ships as cross-platform standalone binaries built by
`.github/workflows/release.yml` on every `v*` tag. Follow these steps.

## Steps

1. **CHANGELOG** — move the `## [Unreleased]` items into a new dated section
   `## [X.Y.Z] — YYYY-MM-DD`, add the `[X.Y.Z]` link at the bottom, and leave a fresh
   empty `## [Unreleased]`.

2. **Bump the version in BOTH places — they must match:**
   - `package.json` → `"version": "X.Y.Z"`
   - `src/version.ts` → `export const VERSION = "X.Y.Z"` (shown in the MCP server banner)

3. **Commit + push to `main`**, then confirm CI is green on Linux + macOS + Windows
   (`gh run watch …` — check the *conclusion*, not just the exit code).

4. **Tag and push the tag:**
   ```bash
   git tag -a vX.Y.Z -m "Lantern vX.Y.Z — one-line summary"
   git push origin vX.Y.Z
   ```
   Avoid backticks / parentheses in the `-m` message — zsh globs them.

5. The tag push triggers **release.yml**, which `bun --compile`s `lantern` +
   `lantern-mcp` for `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`,
   `windows-x64`, writes `SHA256SUMS`, and publishes the GitHub release
   (`gh release create … --generate-notes`).

6. **Verify:**
   ```bash
   RID=$(gh run list --workflow release.yml --event push --limit 1 --json databaseId -q '.[0].databaseId')
   gh run watch "$RID" --exit-status
   gh release view vX.Y.Z --json assets -q '.assets[].name'   # 10 binaries + SHA256SUMS
   ```

## Notes

- **Dry-run the build without tagging:** `gh workflow run release.yml` (workflow_dispatch)
  cross-compiles and uploads the binaries as an *artifact* but does NOT publish a release
  (the publish step is gated on `refs/tags/`). Use it to confirm the build first.
- The binaries bundle the Bun runtime + ssh2 + sqlite + MCP SDK (~60–95 MB each) —
  download-and-run, no install.
- SemVer. Pre-1.0, a minor bump may break compatibility.
- Keep the two GitHub-Actions runtime warnings at zero: first-party actions must target
  Node 24 (currently `cache@v5`, `upload-artifact@v7`, `checkout@v5`, `setup-bun@v2`).
