// Periodic purge of credential_revocations rows that can no longer matter (PRY-085).
//
// A revocation only matters while the credential it blocks could still verify. Once the
// credential is past `exp` plus the clock tolerance, verify rejects it with
// CREDENTIAL_EXPIRED before the blocklist is consulted, so the row is dead weight on a
// table that every verify reads. The selection rule lives in `Blocklist.purgeExpired`.

import type { Logger } from '#observability/logger.js';
import type { Blocklist } from './blocklist.js';

export interface RevocationPurgerDeps {
  blocklist: Blocklist;
  logger: Logger;
  /** Time between runs. 0 disables the purger. */
  intervalSeconds: number;
  now?: () => Date;
}

export interface RevocationPurger {
  /** Runs once immediately, then every `intervalSeconds`. No-op when disabled or started. */
  start(): void;
  stop(): void;
  /** One purge pass. Never throws: a failure is logged and retried on the next tick. */
  runOnce(): Promise<number>;
}

export function createRevocationPurger(deps: RevocationPurgerDeps): RevocationPurger {
  const now = deps.now ?? (() => new Date());
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<number> | undefined;

  async function pass(): Promise<number> {
    const startedAt = Date.now();
    try {
      const purged = await deps.blocklist.purgeExpired(now());
      deps.logger.info(
        { event: 'auth_revocations_purged', purged, durationMs: Date.now() - startedAt },
        'expired credential revocations purged',
      );
      return purged;
    } catch (err) {
      deps.logger.warn(
        {
          event: 'auth_revocations_purge_failed',
          err: err instanceof Error ? err.message : String(err),
        },
        'credential revocation purge failed',
      );
      return 0;
    }
  }

  function runOnce(): Promise<number> {
    running ??= pass().finally(() => {
      running = undefined;
    });
    return running;
  }

  return {
    runOnce,
    start() {
      if (deps.intervalSeconds <= 0 || timer !== undefined) return;
      void runOnce();
      timer = setInterval(() => void runOnce(), deps.intervalSeconds * 1000);
      timer.unref();
    },
    stop() {
      clearInterval(timer);
      timer = undefined;
    },
  };
}
