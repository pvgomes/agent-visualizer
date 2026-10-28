// What the suites can't run on Windows, and why. The control plane (hiring, terminals, keys, the
// background service) only runs on macOS and Linux, so its suites skip there; so do the tests whose
// fakes need a POSIX machine: shell-script CLIs, a local `sh` standing in for a sandbox, file modes,
// signals. What Windows does run (the office, watching transcripts, the MCP server, install) is
// tested there for real.
const WIN = process.platform === "win32";

/** The `skip` for a control plane test. */
export const CONTROL = WIN && "the control plane runs on macOS and Linux only";

/** The `skip` for a test whose fakes are POSIX shell scripts, modes or signals. */
export const POSIX = WIN && "its fakes need a POSIX shell, file modes and signals";

/** `test` with every call skipped for `reason` (when set): a whole file of one kind. */
export function skipAll(test, reason) {
  if (!reason) return test;
  return (name, ...rest) => test(name, { ...(typeof rest[0] === "object" && rest[0] ? rest[0] : {}), skip: reason }, rest[rest.length - 1]);
}
