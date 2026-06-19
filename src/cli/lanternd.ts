#!/usr/bin/env bun
/**
 * lanternd entrypoint — start the daemon on the local unix socket. Holds the
 * env sessions; the `lantern` CLI talks to it per command.
 */
import {
  Daemon,
  defaultAuditPath,
  defaultRegistryDbPath,
  defaultSocketPath,
  fileAuditSink,
  SessionPool,
} from "../daemon";
import { spawnPty } from "../pty";
import { Registry } from "../registry";

const registry = new Registry(defaultRegistryDbPath());
// LOCAL-SHELL mode: run sessions on THIS machine (a local bash) instead of ssh —
// for demos / verifying the stack without a reachable bastion. The su/hop chain
// in the descriptor still drives over that local shell.
const localShell = process.env.LANTERN_LOCAL_SHELL === "1";
const pool = localShell
  ? new SessionPool(registry, () => () => spawnPty(["bash", "--norc", "--noprofile"]))
  : new SessionPool(registry);
if (localShell) {
  process.stderr.write("lanternd: LOCAL-SHELL mode — sessions run on THIS machine (no ssh)\n");
}
const daemon = new Daemon({ registry, pool, audit: fileAuditSink(defaultAuditPath()) });
const socketPath = defaultSocketPath();

daemon.listen(socketPath);
process.stderr.write(`lanternd listening on ${socketPath}\n`);

const shutdown = (): void => {
  daemon.stop();
  void pool.releaseAll().finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
