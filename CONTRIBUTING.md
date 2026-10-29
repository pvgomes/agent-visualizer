# Contributing

Thanks for wanting to make the office better. Support for another agent or sandbox platform is the most useful contribution; fixes, scene details, docs and ideas are welcome too.

## Setup

You need Node 20 or later to work on it (the published CLI runs on Node 18+).

```sh
git clone https://github.com/pvgomes/agent-visualizer
cd agent-visualizer
npm install

npm run dev          # builds, then opens the demo office
node dist/cli.js     # your real agents, from the checkout
```

For work on the page alone, the dev server streams a synthetic office with no transcripts involved:

```sh
node web/ui/dev/dev-server.mjs --scenario cloud   # also: busy, empty, quiet, hostile
```

## How it fits together

- `src/shared/events.ts`: the contract. Every agent's activity becomes the same `OfficeEvent` ("worker X started Edit auth.ts"); the server and the page only ever see these.
- `src/ingest/`: one small parser per agent (`claude.ts`, `codex.ts`, `commandcode.ts`, ...), where it finds the files (`discover.ts`), tailing (`tail.ts`, `source.ts`), the labels (`redact.ts`, `categories.ts`), the agents' own MCP signals (`signals.ts`) and which agents are running right now (`presence.ts`).
- `src/remote/`: the same reads inside sandboxes and on ssh boxes. Each platform is a `RemoteTarget` with one primitive, `exec(sh script)`: `ssh.ts`, `daytona.ts`, `vercel.ts`, `railway.ts`, `boat.ts`.
- `src/server/`: the office's memory (`state.ts`: who's here, idle, supervising, gone) and the localhost server (`http.ts`, `static.ts`) with SSE at `/events`.
- `src/mcp/` and `src/install/`: the office MCP server and the installer that registers it, with the skill from `skills/agent-visualizer/`, in every agent.
- `src/demo/`: the simulated office behind `--demo`.
- `web/scene/`: the Canvas 2D office: layout, sprites, props, lighting, labels and CRT. `web/ui/`: everything around it (top bar, feed, inspector, toolbar, capture). `web/contract.ts` is the seam between the two.
- `test/`: `node --test` suites. They bundle the TypeScript on the fly, so there is no build step between editing and testing.

## Add an agent

1. **Find its transcripts.** Where it writes them, in what format, and how a session, a subagent and a tool call look. Add a `Driver` to `src/ingest/discover.ts` that lists and classifies its files.
2. **Write a parser** next to the others: lines in, `RawEvent`s out, through the helpers in `common.ts` (`newCtx`, `emit`, `setCwd`, `toolFields`). Map its tools onto the office's categories in `categories.ts`, and route every label through `redact.ts`.
3. **Teach presence its process**, so the worker leaves when the agent quits: its binary name in `BINARIES` (or its package path in `SCRIPTS`) in `src/ingest/presence.ts`.
4. **Give it a face.** A `BRAND` entry in `src/shared/events.ts` (name, colour, ink) and its logo in `assets/logos/<agent>.svg`, using `currentColor`.
5. **Test it with synthetic fixtures** in `test/fixtures/<agent>/`. Write them by hand: never commit a real transcript, not even a redacted one.

If the agent can host the office's MCP server, add it to `src/install/agents.ts` too.

## Add a sandbox platform

A platform is a `RemoteTarget` in `src/remote/`: discover the login (environment keys first, then the platform's CLI login files, never a prompt), list the running sandboxes in the user's own scope, and run a POSIX `sh` script inside one through `exec`. Test it against a fake HTTP server or a fake CLI like the others in `test/remote.*.test.mjs`; tests never touch a real account.

## The privacy rules

People screen-record this, so every label obeys these, with no exceptions:

- An action and a file name, never content: "Edit auth.ts", "$ npm test". No prompt text, no file contents, no command arguments past the subcommand.
- Basenames only, `~` for the home folder, IPs masked.
- Anything that looks like a key or token is dropped, and the server re-redacts every event on the way in, so one parser's bug can't leak.
- Nothing leaves the machine except calls to the platforms and boxes the user is logged in to or configured.

## Checks

```sh
npm run typecheck
npm test             # builds, then runs every suite
```

CI runs the same on every pull request. For changes to the page, add a screenshot before and after to the pull request, at desktop and phone width.

## Pull requests

Keep them focused: one agent, one fix or one feature each. Fill in the template, say how you tested it and on which agents, and link the issue if there is one.

## Releasing

For now agent-visualizer installs straight from GitHub (`npx github:pvgomes/agent-visualizer`, or `npm pack github:pvgomes/agent-visualizer` and `npm install -g` the `.tgz`): npm fetches `main`, installs the dev dependencies, runs `prepare` (which builds `dist/`) and packs what `files` lists. So `main` must always build.

The npm package, `@pvgomes/agent-visualizer`, isn't published yet. When it is, cut a release from an up-to-date `main`:

```sh
npm version patch        # or minor / major: bumps package.json and tags vX.Y.Z
npm publish              # prepare builds dist/; publishConfig makes it public
git push --follow-tags
```

`npx @pvgomes/agent-visualizer install` registers agents with the exact version it ran as (`npx -y @pvgomes/agent-visualizer@X.Y.Z mcp`) and refuses until that version is on npm, so publish before announcing a release.
