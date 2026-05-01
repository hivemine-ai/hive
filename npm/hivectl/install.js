// Postinstall verification (warning-only, never fails the install).
//
// npm filters `optionalDependencies` by `os` and `cpu` so only the matching
// platform binary package gets installed. If the operator's platform isn't in
// our supported list, or the matching binary package failed to install for any
// reason, surface a warning so the operator sees it before running `hivectl`.
// Convention: esbuild / swc / cotctl pattern — never break the install.

const os = require('node:os');

const key = `${process.platform} ${os.arch()}`;
const PLATFORMS = {
  'darwin arm64': '@hivemine/hivectl-darwin-arm64',
  'darwin x64': '@hivemine/hivectl-darwin-x64',
  'linux arm64': '@hivemine/hivectl-linux-arm64',
  'linux x64': '@hivemine/hivectl-linux-x64',
};

const pkg = PLATFORMS[key];
if (!pkg) {
  console.warn(
    `[hivectl] platform ${key} is not supported by @hivemine/hivectl. ` +
      `Supported: ${Object.keys(PLATFORMS).join(', ')}.`,
  );
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
