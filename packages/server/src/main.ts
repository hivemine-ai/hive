// Entry point of the Hive v0.1 OSS server process.
//
// Boots the composition root (`buildWire`), starts the HTTP listener, and
// installs SIGTERM/SIGINT handlers that drive a graceful shutdown.

import { createLogger } from './observability/logger.js';
import { buildWire } from './composition/wire.js';

async function main(): Promise<void> {
  const logger = createLogger({
    level: process.env['HIVE_MCP_LOG_LEVEL'] ?? 'info',
    pretty: process.env['HIVE_MCP_LOG_PRETTY'] === 'true',
  });

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
