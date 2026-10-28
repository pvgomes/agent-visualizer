/*
 * Copied from site/shims/node.ts (the landing page's), so the video builds
 * even while the site changes. Browser stand-ins for the node built-ins the office's state module pulls in
 * (src/server/state.ts -> node:os, and src/ingest/presence.ts -> node:child_process
 * and node:fs/promises). video/tools/build.mjs aliases every `node:*` import
 * here. The video only folds scripted events, so none of these run: the
 * state is built with `home: null` and nothing scans processes.
 */
export const homedir = (): string => "";
export const platform = (): string => "browser";

export function execFile(_cmd: string, _args: string[], _opts: unknown, cb?: (err: Error | null, stdout: string) => void): void {
  cb?.(new Error("not available in the browser"), "");
}

export async function readlink(): Promise<string> {
  throw new Error("not available in the browser");
}

export async function readFile(): Promise<string> {
  throw new Error("not available in the browser");
}

export default { homedir, platform, execFile, readlink, readFile };
