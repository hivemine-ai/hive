#!/bin/sh
# Registration audit of the smoke Hive: one row per agent_enrolled /
# agent_claimed event, with the agent name. A restart that renews shows no new
# row; a claim shows agent_claimed.
exec sqlite3 "$SMOKE/hive/hive.sqlite" \
  "select a.occurred_at, a.category, g.name from audit_log a left join agents g on g.id = a.subject_id where a.category in ('agent_enrolled', 'agent_claimed') order by a.occurred_at"
