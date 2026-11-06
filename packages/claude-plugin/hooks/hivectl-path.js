// The command that runs hivectl. `hivectl claude install` rewrites this file in
// the installed copy of the plugin with the absolute path of the executable (or
// node plus the entry script), never the npm wrapper: the processes Claude Code
// and this mod launch must have `claude` as their parent.

/** @type {readonly string[]} */
export const HIVECTL = ['hivectl'];
