// Template generators for the systemd unit (Linux) and launchd plist (Mac).
// Pure string builders — no filesystem or process side effects. Snapshot-tested.
//
// Per the hivectl + Admin Operations tech spec § "service install":
//   - Linux:   /etc/systemd/system/hive.service
//   - Darwin:  ~/Library/LaunchAgents/com.hivemine.hivectl.plist
//
// `execPath` is normally `process.execPath` resolved at install time. For
// the SEA + npm path (PRY-033) it points at the wrapper-installed binary;
// for the dev path (`pnpm exec hivectl`) it points at the node binary
// running the CLI bundle. Both forms are correct for the unit file.

import { LAUNCHD_LABEL } from '#platform/detect.js';

export interface SystemdUnitInput {
  execPath: string;
  workingDir: string;
  user: string;
}

export interface LaunchdPlistInput {
  execPath: string;
  workingDir: string;
  stdoutPath: string;
  stderrPath: string;
}

/**
 * Returns the contents of the systemd unit file for the Hive MCP server.
 *
 * `Restart=on-failure` keeps the server alive across crashes. `RestartSec=5`
 * avoids hot-loops during a deterministic crash. `User=hive` runs the server
 * under the dedicated system user (closes INC-2026-001 FLAG-002).
 */
export function renderSystemdUnit(input: SystemdUnitInput): string {
  return [
    '[Unit]',
    'Description=Hive MCP server (v0.1 OSS)',
    'After=network.target',
    '',
    '[Service]',
    'Type=simple',
    `User=${input.user}`,
    `Group=${input.user}`,
    `WorkingDirectory=${input.workingDir}`,
    `ExecStart=${input.execPath} serve`,
    'Restart=on-failure',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n');
}

/**
 * Returns the contents of the launchd plist for the Hive MCP server.
 *
 * `KeepAlive` is a dict with `SuccessfulExit=false` + `Crashed=true` rather
 * than `<true/>` to avoid respawn loops on intentional exits (e.g. `migrate
 * up` followed by `serve` — the migrate's clean exit shouldn't trigger a
 * respawn). `RunAtLoad=false` matches the spec — the operator runs `launchctl
 * load` to start the service explicitly.
 */
export function renderLaunchdPlist(input: LaunchdPlistInput): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${LAUNCHD_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    <string>${input.execPath}</string>`,
    '    <string>serve</string>',
    '  </array>',
    '  <key>WorkingDirectory</key>',
    `  <string>${input.workingDir}</string>`,
    '  <key>RunAtLoad</key>',
    '  <false/>',
    '  <key>KeepAlive</key>',
    '  <dict>',
    '    <key>SuccessfulExit</key>',
    '    <false/>',
    '    <key>Crashed</key>',
    '    <true/>',
    '  </dict>',
    '  <key>StandardOutPath</key>',
    `  <string>${input.stdoutPath}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${input.stderrPath}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}
