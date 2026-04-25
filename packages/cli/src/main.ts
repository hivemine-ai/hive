// hivectl — admin CLI for Hive operators.
// Slice 0 exposes only `hivectl init`.

import { Command } from 'commander';

import { isAuthError } from '@hive/server';

import { performInit } from './init.js';

interface InitCliOptions {
  db: string;
  hiveName: string;
  adminEmail?: string;
  adminName?: string;
  keysDir: string;
  ttlDays: string;
  operatorNote?: string;
}

const program = new Command();
program.name('hivectl').description('Admin CLI for Hive').version('0.1.0-dev');

program
  .command('init')
  .description('Bootstrap a fresh Hive (creates schema, admin Hivekeeper, signing key).')
  .option('--db <url>', 'database URL', 'sqlite:./var/db/hive.sqlite')
  .option('--hive-name <name>', 'human-readable Hive name', 'Hive')
  .option('--admin-email <email>', 'admin Hivekeeper email (REQUIRED)')
  .option('--admin-name <name>', 'admin display name (optional)')
  .option('--keys-dir <path>', 'directory for signing key PEMs', './var/keys')
  .option('--ttl-days <days>', 'initial credential TTL in days', '365')
  .option('--operator-note <text>', 'free-form audit note for `hivectl init`')
  .action(async (cliOpts: InitCliOptions) => {
    if (!cliOpts.adminEmail) {
      process.stderr.write('error: --admin-email is required\n');
      process.exit(2);
    }
    const ttlMs = Number.parseInt(cliOpts.ttlDays, 10) * 24 * 60 * 60 * 1000;
    if (Number.isNaN(ttlMs) || ttlMs <= 0) {
      process.stderr.write(
        `error: --ttl-days must be a positive integer, got '${cliOpts.ttlDays}'\n`,
      );
      process.exit(2);
    }
    const initOpts: Parameters<typeof performInit>[0] = {
      db: cliOpts.db,
      hiveName: cliOpts.hiveName,
      adminEmail: cliOpts.adminEmail,
      keysDir: cliOpts.keysDir,
      ttlMs,
    };
    if (cliOpts.adminName !== undefined) initOpts.adminDisplayName = cliOpts.adminName;
    if (cliOpts.operatorNote !== undefined) initOpts.operatorNote = cliOpts.operatorNote;
    const osUser = process.env['USER'];
    if (osUser !== undefined) initOpts.osUser = osUser;

    try {
      const result = await performInit(initOpts);
      process.stdout.write(`${result.initialCredential.jwt}\n`);
    } catch (err: unknown) {
      if (isAuthError(err)) {
        process.stderr.write(`error: ${err.code}${err.subCode ? ` (${err.subCode})` : ''}\n`);
        process.exit(err.code === 'HIVE_ALREADY_INITIALIZED' ? 3 : 1);
      }
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`error: ${msg}\n`);
      process.exit(1);
    }
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`fatal: ${msg}\n`);
  process.exit(1);
});
