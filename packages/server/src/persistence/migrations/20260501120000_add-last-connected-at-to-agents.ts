/* eslint-disable @typescript-eslint/no-explicit-any -- Kysely migrations are intentionally
   schema-agnostic; the generic type doesn't reference the current Database interface. */
import type { Kysely } from 'kysely';

// PRY-030 — add `last_connected_at` to the agents table. Persisted cross-restart
// so `get_agent_status` (Tool 7) can resolve the timestamp of the most recent
// closed session even after the server reboots. Populated as a non-blocking side
// effect of `presenceRegistry.subscribe` (workers + scouts only). NULL for agents
// that have never connected.
//
// Stored as TEXT (ISO 8601 UTC) — same idiom every other timestamp in this schema
// uses, portable between SQLite and Postgres without dialect-specific casts.

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('agents').addColumn('last_connected_at', 'text').execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('agents').dropColumn('last_connected_at').execute();
}
