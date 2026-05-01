// Entry point of the Hive v0.1 OSS server process.
//
// Boots the composition root (`buildWire`), starts the HTTP listener, and
// installs SIGTERM/SIGINT handlers that drive a graceful shutdown.
//
// DEPRECATED standalone invocation (PRY-031): once `hivectl` consolidates
// the server inside the CLI binary, prefer `hivectl serve`. Direct
// `node packages/server/dist/main.js` invocation still works for
// backwards-compat (Docker entry point, transitional deployments) but
// emits a one-shot stderr warning so operators migrate.

import { createLogger } from './observability/logger.js';
import type { LoggerOptions } from './observability/logger.js';
import { buildWire } from './composition/wire.js';

const DEPRECATION_NOTICE =
  '[deprecation] direct `node packages/server/dist/main.js` invocation is deprecated. ' +
  'Use `hivectl serve` instead — see docs/mcp-server.md. This entry point will be ' +
  'removed in a future release.\n';

async function main(): Promise<void> {
  // Emit on every invocation per Q3 of PRY-031: standalone invocations are
  // expected to be rare post-merge (CI smoke + transitional Docker only),
  // so cross-invocation idempotency adds no operator value.
  process.stderr.write(DEPRECATION_NOTICE);

  const loggerOpts: LoggerOptions = { pretty: process.env['HIVE_MCP_LOG_PRETTY'] === 'true' };
  const rawLevel = process.env['HIVE_MCP_LOG_LEVEL'];
  if (rawLevel !== undefined) {
    loggerOpts.level = rawLevel as
      | 'trace'
      | 'debug'
      | 'info'
      | 'warn'
      | 'error'
      | 'fatal'
      | 'silent';
  }
  const logger = createLogger(loggerOpts);

  let wire: Awaited<ReturnType<typeof buildWire>>;
  try {
    wire = await buildWire({ logger });
  } catch (err) {
    logger.error(
      { event: 'wire_boot_failed', err: err instanceof Error ? err.message : String(err) },
      'failed to bootstrap hive server',
    );
    process.exitCode = 1;
    return;
  }

  let stopping = false;
  async function shutdown(signal: string): Promise<void> {
    if (stopping) return;
    stopping = true;
    logger.info({ event: 'signal_received', signal }, 'shutdown signal received');
    try {
      await wire.stop();
    } catch (err) {
      logger.error(
        { event: 'wire_stop_unhandled', err: err instanceof Error ? err.message : String(err) },
        'unhandled error during wire.stop',
      );
      process.exitCode = 1;
      return;
    }
    process.exit(process.exitCode ?? 0);
  }

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });

  try {
    await wire.start();
  } catch (err) {
    logger.error(
      { event: 'wire_start_failed', err: err instanceof Error ? err.message : String(err) },
      'failed to start hive server',
    );
    process.exitCode = 1;
  }
}

void main();
