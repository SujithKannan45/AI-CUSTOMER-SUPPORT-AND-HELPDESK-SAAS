/**
 * Ordered shutdown registry.
 *
 * Subsystems that own long-lived resources (HTTP server, Mongo connection,
 * future Socket.IO, BullMQ workers, AI clients) register a teardown function
 * here at boot. On SIGTERM/SIGINT, hooks run sequentially in registration
 * order — a socket.io `io.close()` or `worker.close()` becomes a one-line
 * addition, not a rework of server.ts.
 */

export type ShutdownHook = () => Promise<void> | void;

const hooks: ShutdownHook[] = [];

export function registerShutdownHook(hook: ShutdownHook): void {
  hooks.push(hook);
}

/** Runs all hooks sequentially; collects failures but keeps going. */
export async function runShutdownHooks(): Promise<void> {
  for (const hook of hooks) {
    try {
      await hook();
    } catch (error) {
      // Logger is avoided here to prevent circular imports; shutdown logging
      // happens in server.ts around this call.
      // eslint-disable-next-line no-console
      console.error('Shutdown hook failed:', error);
    }
  }
  hooks.length = 0;
}
