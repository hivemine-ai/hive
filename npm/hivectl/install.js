// Postinstall verification (warning-only, never fails the install).
//
// npm filters `optionalDependencies` by `os` and `cpu` so only the matching
// platform binary package gets installed. If the operator's platform isn't in
// our supported list, or the matching binary package failed to install for any
// reason, surface a warning so the operator sees it before running `hivectl`.
// Convention: esbuild / swc / cotctl pattern — never break the install.

const os = require('node:os');

const key = `${process.platform} ${os.arch()}`;
// `darwin x64` (Intel Mac) intentionally absent in v0.1.0 — see CHANGELOG.md
// for the GitHub Actions runner rationale (free org plan does not include
// `macos-*-large`, and `macos-13` pool scarcity blocked the dry-run). Mac
// Intel users use the `linux x64` binary via Rosetta 2; the warning branch
// below points them at that escape hatch.
const PLATFORMS = {
  'darwin arm64': '@hivemine/hivectl-darwin-arm64',
  'linux arm64': '@hivemine/hivectl-linux-arm64',
  'linux x64': '@hivemine/hivectl-linux-x64',
};

const pkg = PLATFORMS[key];
if (!pkg) {
  if (key === 'darwin x64') {
    console.warn(
      `[hivectl] platform darwin x64 (Intel Mac) is not supported by ` +
        `@hivemine/hivectl in v0.1.0. Workaround: install Rosetta 2 ` +
        `(\`softwareupdate --install-rosetta\` on macOS 15+; macOS 11-14 ` +
        `prompt automatically) and use the linux x64 binary.`,
    );
  } else {
    console.warn(
      `[hivectl] platform ${key} is not supported by @hivemine/hivectl. ` +
        `Supported: ${Object.keys(PLATFORMS).join(', ')}.`,
    );
  }
  process.exit(0);
}

try {
  require.resolve(`${pkg}/package.json`);
} catch {
  console.warn(
    `[hivectl] platform package ${pkg} is not installed. ` +
      `Reinstall with: npm install -g @hivemine/hivectl`,
  );
}
