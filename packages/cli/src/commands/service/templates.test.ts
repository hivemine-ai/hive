import { describe, expect, it } from 'vitest';

import { renderLaunchdPlist, renderSystemdUnit } from './templates.js';

describe('renderSystemdUnit', () => {
  it('matches the canonical layout (snapshot)', () => {
    const unit = renderSystemdUnit({
      execPath: '/usr/local/bin/hivectl',
      workingDir: '/var/lib/hive',
      user: 'hive',
    });
    expect(unit).toMatchInlineSnapshot(`
      "[Unit]
      Description=Hive MCP server (v0.1 OSS)
      After=network.target

      [Service]
      Type=simple
      User=hive
      Group=hive
      WorkingDirectory=/var/lib/hive
      ExecStart=/usr/local/bin/hivectl serve
      Restart=on-failure
      RestartSec=5

      [Install]
      WantedBy=multi-user.target
      "
    `);
  });

  it('honours custom user + working dir', () => {
    const unit = renderSystemdUnit({
      execPath: '/opt/hive/bin/hivectl',
      workingDir: '/srv/hive',
      user: 'hive-dev',
    });
    expect(unit).toContain('User=hive-dev');
    expect(unit).toContain('Group=hive-dev');
    expect(unit).toContain('WorkingDirectory=/srv/hive');
    expect(unit).toContain('ExecStart=/opt/hive/bin/hivectl serve');
  });

  it('uses Restart=on-failure (NOT always — avoids hot-loops)', () => {
    const unit = renderSystemdUnit({
      execPath: '/usr/local/bin/hivectl',
      workingDir: '/var/lib/hive',
      user: 'hive',
    });
    expect(unit).toContain('Restart=on-failure');
    expect(unit).not.toContain('Restart=always');
  });
});

describe('renderLaunchdPlist', () => {
  it('matches the canonical layout (snapshot)', () => {
    const plist = renderLaunchdPlist({
      execPath: '/usr/local/bin/hivectl',
      workingDir: '/Users/op/Library/Application Support/Hive',
      stdoutPath: '/Users/op/Library/Logs/Hive/hive.log',
      stderrPath: '/Users/op/Library/Logs/Hive/hive.err',
    });
    expect(plist).toMatchInlineSnapshot(`
      "<?xml version="1.0" encoding="UTF-8"?>
      <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
      <plist version="1.0">
      <dict>
        <key>Label</key>
        <string>com.hivemine.hivectl</string>
        <key>ProgramArguments</key>
        <array>
          <string>/usr/local/bin/hivectl</string>
          <string>serve</string>
        </array>
        <key>WorkingDirectory</key>
        <string>/Users/op/Library/Application Support/Hive</string>
        <key>RunAtLoad</key>
        <false/>
        <key>KeepAlive</key>
        <dict>
          <key>SuccessfulExit</key>
          <false/>
          <key>Crashed</key>
          <true/>
        </dict>
        <key>StandardOutPath</key>
        <string>/Users/op/Library/Logs/Hive/hive.log</string>
        <key>StandardErrorPath</key>
        <string>/Users/op/Library/Logs/Hive/hive.err</string>
      </dict>
      </plist>
      "
    `);
  });

  it('uses KeepAlive dict with SuccessfulExit=false + Crashed=true (no respawn loops)', () => {
    const plist = renderLaunchdPlist({
      execPath: '/usr/local/bin/hivectl',
      workingDir: '/Users/op/Library/Application Support/Hive',
      stdoutPath: '/Users/op/Library/Logs/Hive/hive.log',
      stderrPath: '/Users/op/Library/Logs/Hive/hive.err',
    });
    // The risk a flat <true/> would create: a clean exit (e.g. `migrate up`
    // before `serve`) would be respawned by launchd in a tight loop.
    expect(plist).toContain('<key>KeepAlive</key>');
    expect(plist).toContain('<key>SuccessfulExit</key>');
    expect(plist).toContain('<key>Crashed</key>');
    expect(plist).not.toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
  });

  it('RunAtLoad=false (operator triggers start explicitly via `service start`)', () => {
    const plist = renderLaunchdPlist({
      execPath: '/usr/local/bin/hivectl',
      workingDir: '/x',
      stdoutPath: '/y',
      stderrPath: '/z',
    });
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<false\/>/);
  });

  it('Label matches the canonical com.hivemine.hivectl', () => {
    const plist = renderLaunchdPlist({
      execPath: '/x',
      workingDir: '/y',
      stdoutPath: '/a',
      stderrPath: '/b',
    });
    expect(plist).toContain('<string>com.hivemine.hivectl</string>');
  });
});
