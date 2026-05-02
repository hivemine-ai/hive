// Build the commander tree. Each subcommand is registered with a thin handler
// that resolves the runtime, calls the domain function, and renders output.
//
// Globals are exposed via `program.opts()` (commander parent scope) — every
// handler reads them before delegating.

import { Command } from 'commander';
import { createLogger } from '@hive/server';
import type { Logger } from '@hive/server';

import { runAuditQuery } from './commands/audit/query.js';
import { runCreateAgent } from './commands/agent/create.js';
import { runListAgents } from './commands/agent/list.js';
import { runRevokeAgent } from './commands/agent/revoke.js';
import { registerConfigGroup } from './commands/config/index.js';
import { runIssueCredential } from './commands/credential/issue.js';
import { runListCredentials } from './commands/credential/list.js';
import { runRevokeCredential } from './commands/credential/revoke.js';
import { runRotateCredential } from './commands/credential/rotate.js';
import { runListKeepers } from './commands/hive/list-keepers.js';
import { runCreateHivekeeper } from './commands/hivekeeper/create.js';
import { runInit } from './commands/init.js';
import { performMigrate } from './commands/migrate.js';
import { parseLogLevel, runServe } from './commands/serve.js';
import { registerServiceGroup } from './commands/service/index.js';
import { mapErrorToExit } from './error/handler.js';
import { asOptionalNumber, asOptionalString, asString, asStringArray } from './input/coerce.js';
import { formatOutput, formatOutputList, resolveOutputMode } from './output/format.js';
import {
  auditEntrySchema,
  createAgentSchema,
  createHivekeeperSchema,
  initSchema,
  issueCredentialSchema,
  listAgentsSchema,
  listCredentialsSchema,
  listKeepersSchema,
  migrateSchema,
  revokeAgentSchema,
  revokeCredentialSchema,
  rotateCredentialSchema,
} from './output/schemas.js';
import { closeRuntime, getRuntime } from './runtime/lazy-runtime.js';
import type { GlobalCliOpts, OutputMode } from './types.js';

interface RootCliOpts {
  output?: string;
  yes?: boolean;
  noColor?: boolean;
  operatorId?: string;
  operatorNote?: string;
  config?: string;
  verbose?: boolean;
}

interface RuntimeState {
  exitCode: number;
  logger: Logger;
  globals: GlobalCliOpts;
}

function makeState(rootOpts: RootCliOpts): RuntimeState {
  const verbose = rootOpts.verbose === true;
  const rawLevel = verbose ? 'debug' : (process.env['HIVE_CLI_LOG_LEVEL'] ?? 'warn');
  const logger = createLogger({
    level: rawLevel as 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent',
  });
  const output = resolveOutputMode(rootOpts.output, Boolean(process.stdout.isTTY));
  const globals: GlobalCliOpts = {
    output,
    yes: rootOpts.yes === true,
    noColor: rootOpts.noColor === true || process.env['NO_COLOR'] !== undefined,
    verbose,
  };
  if (rootOpts.operatorId !== undefined) {
    // Per ADR-020: store the raw input. `buildOperatorActor` resolves it
    // (UUID v7 OR Hivekeeper email) once the runtime is up.
    globals.operatorId = rootOpts.operatorId;
  }
  if (rootOpts.operatorNote !== undefined) globals.operatorNote = rootOpts.operatorNote;
  if (rootOpts.config !== undefined) globals.configFile = rootOpts.config;
  return { exitCode: 0, logger, globals };
}

function writeStdout(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

function writeError(message: string): void {
  process.stderr.write(message.endsWith('\n') ? message : `${message}\n`);
}

async function runHandler<T>(
  state: RuntimeState,
  fn: () => Promise<T>,
  formatOk: (value: T, mode: OutputMode) => string,
): Promise<void> {
  try {
    const value = await fn();
    writeStdout(formatOk(value, state.globals.output));
  } catch (err) {
    const mapped = mapErrorToExit(err);
    writeError(`error: ${mapped.message}`);
    state.exitCode = mapped.code;
  }
}

export interface BuildProgramResult {
  program: Command;
  /** After `parseAsync`, read this for the resolved exit code (default 0). */
  getExitCode: () => number;
}

export function buildProgram(): BuildProgramResult {
  const program = new Command();
  program
    .name('hivectl')
    .description(
      'Admin CLI for Hive — bootstrap, manage participants, issue credentials, query audit log.',
    )
    .version('0.1.0-dev')
    .option('-o, --output <format>', 'output format: table | json | yaml', undefined)
    .option('-y, --yes', 'skip confirmation prompts (required for destructive ops)')
    .option('--no-color', 'disable ANSI colors in output')
    .option(
      '--operator-id <email-or-uuid>',
      'attribute the audit event to this Hivekeeper (email or UUID v7)',
    )
    .option('--operator-note <text>', 'free-form audit note (capped at 256 chars)')
    .option('--config <path>', 'optional .env file with overrides')
    .option('-v, --verbose', 'bump log level to debug');

  // The root state is built lazily inside each handler so that --help / --version
  // do not trigger logger init.
  const stateRef: { current: RuntimeState | null } = { current: null };
  function state(): RuntimeState {
    if (stateRef.current === null) {
      stateRef.current = makeState(program.opts<RootCliOpts>());
    }
    return stateRef.current;
  }

  // ── serve ─────────────────────────────────────────────────────────────
  // Foreground MCP server. Reuses the server composition root directly.
  // Does NOT use the lazy CLI runtime — it owns the full server lifetime
  // and handles its own SIGINT/SIGTERM shutdown.
  program
    .command('serve')
    .description('Run the Hive MCP server in the foreground (blocks until SIGINT/SIGTERM).')
    .option('--port <n>', 'HTTP listen port (overrides HIVE_MCP_HTTP_PORT)')
    .option('--host <addr>', 'HTTP bind address (overrides HIVE_MCP_HTTP_HOST)')
    .option(
      '--log-level <level>',
      "log level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'",
    )
    .option('--log-pretty', 'force pino-pretty output (overrides HIVE_MCP_LOG_PRETTY)')
    .action(async (cmdOpts: Record<string, unknown>) => {
      const portStr = asOptionalString(cmdOpts['port']);
      const port = portStr === undefined ? undefined : Number(portStr);
      // Port 0 is the OS-assigned ephemeral port — useful for tests and
      // dev-with-random-port; the listener binds successfully and the bound
      // port is reported in the `wire_started` log line.
      if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
        writeError(`error: --port must be an integer between 0 and 65535 (got "${portStr}")`);
        if (stateRef.current === null) {
          stateRef.current = makeState(program.opts<RootCliOpts>());
        }
        stateRef.current.exitCode = 2;
        return;
      }
      let logLevel: ReturnType<typeof parseLogLevel> = undefined;
      try {
        logLevel = parseLogLevel(asOptionalString(cmdOpts['logLevel']));
      } catch (err) {
        writeError(`error: ${err instanceof Error ? err.message : String(err)}`);
        if (stateRef.current === null) {
          stateRef.current = makeState(program.opts<RootCliOpts>());
        }
        stateRef.current.exitCode = 2;
        return;
      }
      const logPretty = cmdOpts['logPretty'] === true ? true : undefined;
      await runServe({
        port,
        host: asOptionalString(cmdOpts['host']),
        logLevel,
        logPretty,
      });
    });

  // ── init ──────────────────────────────────────────────────────────────
  program
    .command('init')
    .description('Bootstrap a fresh Hive (creates schema, admin Hivekeeper, signing key).')
    .requiredOption('--admin-email <email>', 'admin Hivekeeper email')
    .option('--hive-name <name>', 'human-readable Hive name', 'Hive')
    .option('--admin-display-name <name>', 'admin display name')
    .option(
      '--db <url>',
      'database URL (e.g. sqlite:./var/db/hive.sqlite)',
      'sqlite:./var/db/hive.sqlite',
    )
    .option('--keys-dir <path>', 'directory for signing key PEMs', './var/keys')
    .option('--ttl <duration>', 'initial credential TTL (e.g. 365d, 12h)')
    .option('--output-credential <path>', 'write JWT to this file (perms 0600); otherwise stdout')
    .action(async (cliOpts: Record<string, unknown>) => {
      const s = state();
      await runHandler(
        s,
        () =>
          runInit({
            globals: s.globals,
            adminEmail: asString(cliOpts['adminEmail']),
            hiveName: asOptionalString(cliOpts['hiveName']),
            adminDisplayName: asOptionalString(cliOpts['adminDisplayName']),
            db: asString(cliOpts['db'], 'sqlite:./var/db/hive.sqlite'),
            keysDir: asString(cliOpts['keysDir'], './var/keys'),
            ttl: asOptionalString(cliOpts['ttl']),
            outputCredential: asOptionalString(cliOpts['outputCredential']),
          }),
        (value, mode) => formatOutput(value, { mode, schema: initSchema }),
      );
    });

  // ── migrate ───────────────────────────────────────────────────────────
  const migrate = program.command('migrate').description('Manage database schema migrations.');
  migrate
    .command('up')
    .description('Apply all pending migrations.')
    .action(async () => {
      const s = state();
      await runHandler(
        s,
        () => performMigrate({ globals: s.globals, action: 'up' }),
        (value, mode) => formatOutput(value, { mode, schema: migrateSchema }),
      );
    });
  migrate
    .command('down')
    .description('Roll back the most recent migration. Requires --yes (destructive).')
    .action(async () => {
      const s = state();
      await runHandler(
        s,
        () => performMigrate({ globals: s.globals, action: 'down' }),
        (value, mode) => formatOutput(value, { mode, schema: migrateSchema }),
      );
    });
  migrate
    .command('status')
    .description('List applied migrations.')
    .action(async () => {
      const s = state();
      await runHandler(
        s,
        () => performMigrate({ globals: s.globals, action: 'status' }),
        (value, mode) => formatOutput(value, { mode, schema: migrateSchema }),
      );
    });

  // ── hive ──────────────────────────────────────────────────────────────
  const hive = program.command('hive').description('Hive-level operations.');
  hive
    .command('list-keepers')
    .description('List all Hivekeepers in the Hive.')
    .option('--active-only', 'restrict to keepers with state=active')
    .option('--limit <n>', 'maximum rows returned', '50')
    .action(async (cmdOpts: Record<string, unknown>) => {
      const s = state();
      await runHandler(
        s,
        async () => {
          const runtime = await getRuntime(s.logger);
          const r = await runListKeepers(runtime, {
            globals: s.globals,
            activeOnly: cmdOpts['activeOnly'] === true,
            limit: asOptionalNumber(cmdOpts['limit']),
          });
          return r.keepers;
        },
        (value, mode) => formatOutputList(value, { mode, schema: listKeepersSchema }),
      );
    });

  // ── hivekeeper ────────────────────────────────────────────────────────
  const hivekeeper = program.command('hivekeeper').description('Hivekeeper lifecycle.');
  hivekeeper
    .command('create')
    .description('Create a new Hivekeeper.')
    .requiredOption('--email <email>', 'Hivekeeper email')
    .option('--display-name <name>', 'display name')
    .option('--admin', 'grant admin flag at creation', false)
    .option('--emit-credential', 'also issue an initial credential', false)
    .option('--credential-ttl <duration>', 'TTL for the issued credential')
    .option('--output-credential <path>', 'write JWT to this file (perms 0600)')
    .action(async (cmdOpts: Record<string, unknown>) => {
      const s = state();
      await runHandler(
        s,
        async () => {
          const runtime = await getRuntime(s.logger);
          return runCreateHivekeeper(runtime, {
            globals: s.globals,
            email: asString(cmdOpts['email']),
            displayName: asOptionalString(cmdOpts['displayName']),
            admin: cmdOpts['admin'] === true,
            emitCredential: cmdOpts['emitCredential'] === true,
            credentialTtl: asOptionalString(cmdOpts['credentialTtl']),
            outputCredential: asOptionalString(cmdOpts['outputCredential']),
          });
        },
        (value, mode) => formatOutput(value, { mode, schema: createHivekeeperSchema }),
      );
    });

  // ── agent ─────────────────────────────────────────────────────────────
  const agent = program.command('agent').description('Agent lifecycle.');
  agent
    .command('create')
    .description('Create a new Agent under an existing Hivekeeper.')
    .requiredOption('--owner <ref>', 'owner Hivekeeper (email or UUIDv7)')
    .requiredOption('--name <name>', 'agent name (unique per owner among non-revoked agents)')
    .requiredOption('--type <type>', "'worker' or 'scout'")
    .option('--capability <cap>', 'append a capability (repeatable)', appendValue, [] as string[])
    .option('--instructions <text>', 'free-form instructions')
    .option('--emit-credential', 'also issue an initial credential', false)
    .option('--credential-ttl <duration>', 'TTL for the issued credential')
    .option('--output-credential <path>', 'write JWT to this file (perms 0600)')
    .action(async (cmdOpts: Record<string, unknown>) => {
      const s = state();
      await runHandler(
        s,
        async () => {
          const runtime = await getRuntime(s.logger);
          return runCreateAgent(runtime, {
            globals: s.globals,
            owner: asString(cmdOpts['owner']),
            name: asString(cmdOpts['name']),
            type: asString(cmdOpts['type']) as 'worker' | 'scout',
            capabilities: asStringArray(cmdOpts['capability']) ?? [],
            instructions: asOptionalString(cmdOpts['instructions']),
            emitCredential: cmdOpts['emitCredential'] === true,
            credentialTtl: asOptionalString(cmdOpts['credentialTtl']),
            outputCredential: asOptionalString(cmdOpts['outputCredential']),
          });
        },
        (value, mode) => formatOutput(value, { mode, schema: createAgentSchema }),
      );
    });
  agent
    .command('list')
    .description('List Agents in the Hive.')
    .option('--owner <ref>', 'restrict to one owner (email or UUIDv7)')
    .option('--type <type>', "'worker' or 'scout'")
    .option('--state <state>', "'active' | 'suspended' | 'revoked'")
    .option('--limit <n>', 'maximum rows per page', '50')
    .option('--cursor <cursor>', 'opaque pagination cursor from a previous page')
    .action(async (cmdOpts: Record<string, unknown>) => {
      const s = state();
      await runHandler(
        s,
        async () => {
          const runtime = await getRuntime(s.logger);
          const typeStr = asOptionalString(cmdOpts['type']);
          const stateStr = asOptionalString(cmdOpts['state']);
          const r = await runListAgents(runtime, {
            globals: s.globals,
            owner: asOptionalString(cmdOpts['owner']),
            type: typeStr === undefined ? undefined : (typeStr as 'worker' | 'scout'),
            state:
              stateStr === undefined ? undefined : (stateStr as 'active' | 'suspended' | 'revoked'),
            limit: asOptionalNumber(cmdOpts['limit']),
            cursor: asOptionalString(cmdOpts['cursor']),
          });
          return r.agents;
        },
        (value, mode) => formatOutputList(value, { mode, schema: listAgentsSchema }),
      );
    });
  agent
    .command('revoke <agent-ref>')
    .description(
      'Revoke an Agent (cascade-closes its Cell). Accepts UUID v7 or agent reference (<name>@<owner-local>.<hive>). Requires --yes.',
    )
    .action(async (agentRef: string) => {
      const s = state();
      await runHandler(
        s,
        async () => {
          const runtime = await getRuntime(s.logger);
          return runRevokeAgent(runtime, { globals: s.globals, agentRef });
        },
        (value, mode) => formatOutput(value, { mode, schema: revokeAgentSchema }),
      );
    });

  // ── credential ────────────────────────────────────────────────────────
  const credential = program.command('credential').description('Credential lifecycle.');
  credential
    .command('issue')
    .description('Issue a new credential for a participant.')
    .requiredOption('--participant-id <ref>', 'participant (email or UUIDv7)')
    .option('--ttl <duration>', 'credential TTL')
    .option('--reason <text>', 'free-form audit reason')
    .option('--output-credential <path>', 'write JWT to this file (perms 0600)')
    .action(async (cmdOpts: Record<string, unknown>) => {
      const s = state();
      await runHandler(
        s,
        async () => {
          const runtime = await getRuntime(s.logger);
          return runIssueCredential(runtime, {
            globals: s.globals,
            participantRef: asString(cmdOpts['participantId']),
            ttl: asOptionalString(cmdOpts['ttl']),
            reason: asOptionalString(cmdOpts['reason']),
            outputCredential: asOptionalString(cmdOpts['outputCredential']),
          });
        },
        (value, mode) => formatOutput(value, { mode, schema: issueCredentialSchema }),
      );
    });
  credential
    .command('rotate <jti-or-active-ref>')
    .description(
      'Rotate a credential — issues new + revokes the old. Requires --yes. ' +
        'Accepts a UUID v7 JTI or `<participant-ref>:latest` (per ADR-020) to target ' +
        'the participant’s currently-active credential.',
    )
    .option('--ttl <duration>', 'TTL for the new credential')
    .option('--output-credential <path>', 'write the new JWT to this file (perms 0600)')
    .action(async (jti: string, cmdOpts: Record<string, unknown>) => {
      const s = state();
      await runHandler(
        s,
        async () => {
          const runtime = await getRuntime(s.logger);
          return runRotateCredential(runtime, {
            globals: s.globals,
            jti,
            ttl: asOptionalString(cmdOpts['ttl']),
            outputCredential: asOptionalString(cmdOpts['outputCredential']),
          });
        },
        (value, mode) => formatOutput(value, { mode, schema: rotateCredentialSchema }),
      );
    });
  credential
    .command('revoke <jti-or-active-ref>')
    .description(
      'Revoke a credential. Requires --yes. Accepts a UUID v7 JTI or ' +
        '`<participant-ref>:latest` (per ADR-020) to target the participant’s ' +
        'currently-active credential.',
    )
    .option('--reason <text>', 'free-form audit reason')
    .action(async (jti: string, cmdOpts: Record<string, unknown>) => {
      const s = state();
      await runHandler(
        s,
        async () => {
          const runtime = await getRuntime(s.logger);
          return runRevokeCredential(runtime, {
            globals: s.globals,
            jti,
            reason: asOptionalString(cmdOpts['reason']),
          });
        },
        (value, mode) => formatOutput(value, { mode, schema: revokeCredentialSchema }),
      );
    });
  credential
    .command('list <participant-ref>')
    .description('List credentials for a participant (no JWT raw).')
    .option('--limit <n>', 'maximum rows', '50')
    .action(async (participantRef: string, cmdOpts: Record<string, unknown>) => {
      const s = state();
      await runHandler(
        s,
        async () => {
          const runtime = await getRuntime(s.logger);
          const r = await runListCredentials(runtime, {
            globals: s.globals,
            participantRef,
            limit: asOptionalNumber(cmdOpts['limit']),
          });
          return r.credentials;
        },
        (value, mode) => formatOutputList(value, { mode, schema: listCredentialsSchema }),
      );
    });

  // ── audit ─────────────────────────────────────────────────────────────
  const audit = program.command('audit').description('Audit log queries.');
  audit
    .command('query')
    .description('Query the audit log.')
    .option('--category <category>', 'category to filter (repeatable)', appendValue, [] as string[])
    .option('--decision <decision>', "filter: 'success' | 'denied' | 'error'")
    .option('--actor-id <uuid>', 'filter by actor UUIDv7')
    .option('--subject-id <uuid>', 'filter by subject UUIDv7')
    .option('--from <iso>', 'lower bound on occurred_at (ISO 8601)')
    .option('--until <iso>', 'upper bound on occurred_at (ISO 8601)')
    .option('--limit <n>', 'maximum rows (capped at 500)', '50')
    .action(async (cmdOpts: Record<string, unknown>) => {
      const s = state();
      await runHandler(
        s,
        async () => {
          const runtime = await getRuntime(s.logger);
          const r = await runAuditQuery(runtime, {
            globals: s.globals,
            categories: asStringArray(cmdOpts['category']),
            decision: asOptionalString(cmdOpts['decision']),
            actorId: asOptionalString(cmdOpts['actorId']),
            subjectId: asOptionalString(cmdOpts['subjectId']),
            from: asOptionalString(cmdOpts['from']),
            until: asOptionalString(cmdOpts['until']),
            limit: asOptionalNumber(cmdOpts['limit']),
          });
          return r.entries;
        },
        (value, mode) => formatOutputList(value, { mode, schema: auditEntrySchema }),
      );
    });

  // ── service (lifecycle of the OS-supervised hive service) ──────────────
  // Pre-Fase 2 decision (PRY-032): the group ships with 6 verbs:
  //   install / uninstall / start / stop / restart / status
  // The hooks bridge `setExitCode` so failures bubble up through main.ts.
  const lifecycleHooks = {
    setExitCode: (code: number) => {
      if (stateRef.current === null) {
        stateRef.current = makeState(program.opts<RootCliOpts>());
      }
      stateRef.current.exitCode = code;
    },
  };
  registerServiceGroup(program, lifecycleHooks);

  // ── config (persistent operator-tweakable settings) ────────────────────
  // Currently a single child: `config network <local-only | bind-all>`.
  registerConfigGroup(program, lifecycleHooks);

  return {
    program,
    getExitCode: () => stateRef.current?.exitCode ?? 0,
  };
}

function appendValue(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export { closeRuntime };
