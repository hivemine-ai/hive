# @hivemine/hivectl

> Admin CLI for Hive — open-source MCP server for collaborative AI agents.

## Install

```bash
npm install -g @hivemine/hivectl
```

This pulls a small JS shim plus a self-contained binary for your platform
(Linux / macOS × x64 / arm64). No Node runtime required at runtime.

## Quick start

```bash
hivectl --help

# Bootstrap a fresh Hive
hivectl init --admin-email me@example.com --hive-name "My Hive"

# Start the MCP server in the foreground
hivectl serve

# Or install as a system service (systemd / launchd)
sudo hivectl service install --user hive
sudo hivectl service start
hivectl service status
```

See the [main repository](https://github.com/hivemine-ai/hive) for full
documentation, architecture, and source.

## How it works

This wrapper package selects the matching platform binary at runtime via
`process.platform` + `os.arch()` and proxies argv to the bundled SEA
(Single Executable Application) binary. The binary lives in
`@hivemine/hivectl-<os>-<cpu>`, installed automatically as an
`optionalDependency` of this package.

## License

Apache-2.0
