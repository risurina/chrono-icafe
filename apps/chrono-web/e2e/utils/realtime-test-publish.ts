import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createInterface } from "node:readline";
import * as path from "node:path";
import type { Readable, Writable } from "node:stream";

/**
 * Test-only helper for the realtime e2e specs (`.ai/plans/chrono/active/
 * realtime-updates/README.md`, Phase 4) — mirrors `apps/agora-web/e2e/utils/
 * realtime-test-publish.ts` exactly, per websocket-foundation's own resolved
 * "Decision" paragraph: no test-publish HTTP route is ever added.
 *
 * The real publish call has to run inside the SAME Node process as the API
 * server handling the live sockets (the in-memory provider is a
 * process-local `Map`) — see `apps/chrono-api/src/e2e/realtime-test-server.ts`
 * for the full reasoning and the exact stdin/stdout protocol this spawns and
 * talks to. A subprocess boundary is used here (not a direct source import of
 * `chrono-api`'s internals) because `chrono-web` importing `chrono-api`'s
 * private `src/` would violate `.ai/rules/monorepo.md`'s "apps must not
 * import private files from another app," and `chrono-api` has no public
 * `packages/agora` export for this.
 *
 * IMPORTANT: this replacement server binds the SAME port the developer's own
 * `pnpm dev` `chrono-api` normally uses (`NEXT_PUBLIC_API_URL`'s port, default
 * 8787) — the already-running `chrono-web` Next.js dev server cannot be
 * repointed at a different port at test time. Running these specs requires
 * stopping any separately-running `chrono-api` dev process first.
 */

export type RealtimeTestServer = {
  port: number;
  publishTestEvent(
    tenantId: string,
    scope: string | null,
    event: string,
    payload: unknown,
  ): Promise<void>;
  stop(): Promise<void>;
};

const READY_PREFIX = "REALTIME_TEST_SERVER_READY ";
const PUBLISHED_LINE = "REALTIME_TEST_SERVER_PUBLISHED";

export async function startRealtimeTestServer(): Promise<RealtimeTestServer> {
  const apiDir = path.resolve(__dirname, "../../../chrono-api");
  const child: ChildProcessByStdio<Writable, Readable, null> = spawn(
    "npx",
    ["tsx", "src/e2e/realtime-test-server.ts"],
    { cwd: apiDir, stdio: ["pipe", "pipe", "inherit"] },
  );

  const stdout = createInterface({ input: child.stdout });
  const port = await new Promise<number>((resolve, reject) => {
    const onLine = (line: string) => {
      if (line.startsWith(READY_PREFIX)) {
        stdout.off("line", onLine);
        resolve(Number(line.slice(READY_PREFIX.length).trim()));
      }
    };
    stdout.on("line", onLine);
    child.once("exit", (code) => reject(new Error(`realtime-test-server exited early (code ${code})`)));
  });

  return {
    port,
    publishTestEvent(tenantId, scope, event, payload) {
      return new Promise<void>((resolve) => {
        const onLine = (line: string) => {
          if (line === PUBLISHED_LINE) {
            stdout.off("line", onLine);
            resolve();
          }
        };
        stdout.on("line", onLine);
        child.stdin.write(
          JSON.stringify({ tenantId, scope, event, payload }) + "\n",
        );
      });
    },
    async stop() {
      child.stdin.write("exit\n");
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        setTimeout(() => {
          child.kill("SIGTERM");
          resolve();
        }, 2000);
      });
    },
  };
}
