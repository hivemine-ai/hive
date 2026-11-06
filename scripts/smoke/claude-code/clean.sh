#!/bin/sh
# Runs a command without the variables of a parent Claude Code session (so a
# smoke `claude` started from inside another session does not see itself as
# nested) and without the parent's tmux variables.
for v in $(env | grep -E '^(CLAUDECODE|CLAUDE_CODE_[A-Z_]*|CLAUDE_EFFORT|CLAUDE_PID|CLAUDE_AGENT_[A-Z_]*|TMUX|TMUX_PANE)=' | cut -d= -f1); do
  unset "$v"
done
exec "$@"
