// Generic guard helpers for runtime configuration consistency.
//
// `warnSweepMisconfig` covers the pattern: a component with a periodic sweep
// has two knobs — a threshold (e.g. `idleTimeoutMs`) and an interval (e.g.
// `sweepIntervalMs`). If the threshold is enabled (> 0) but the interval is
// not configured (<= 0), the sweep is silently inactive — a footgun. The
// guard emits a single `warn { event: 'config_sweep_misconfigured' }` so
// operators see the issue at startup rather than during incident triage.
//
// The naming `config-guard.ts` (not `audit.ts`) avoids semantic collision
// with `domain/audit/` (the audit log recorder). This helper guards config
// consistency, not event audit. See Observability tech spec § "Decisión:
// Naming `observability/config-guard.ts` vs `observability/audit.ts`".

import type { Logger } from '#observability/logger.js';

export interface SweepConfigSnapshot {
  /** Threshold of the sweep (e.g. idleTimeoutMs). null/0 = sweep disabled. */
  enabledMs: number | null;
  /** Period of the sweep timer (e.g. sweepIntervalMs). 0 = no timer is mounted. */
  intervalMs: number;
}

/**
 * Logs a warn `{ event: 'config_sweep_misconfigured' }` iff the sweep is
 * enabled (`enabledMs > 0`) but no timer will be mounted (`intervalMs <= 0`).
 * Silent in any other configuration.
 *
 * Caller is responsible for invoking this once at construction. Calling
 * it on every sweep tick would flood the warn channel.
 */
export function warnSweepMisconfig(
  logger: Logger,
  componentName: string,
  config: SweepConfigSnapshot,
): void {
  const enabled = config.enabledMs ?? 0;
  if (enabled > 0 && config.intervalMs <= 0) {
    logger.warn(
      {
        event: 'config_sweep_misconfigured',
        component: componentName,
        enabledMs: config.enabledMs,
        intervalMs: config.intervalMs,
      },
      `${componentName}: enabledMs > 0 but intervalMs <= 0 — sweep will not run`,
    );
  }
}
