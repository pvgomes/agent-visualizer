# agent-visualizer

[![powered by pvgomes](https://img.shields.io/badge/powered%20by-pvgomes-181717)](https://pvgomes.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-181717?logo=typescript&logoColor=white)](tsconfig.json)
[![zero dependencies](https://img.shields.io/badge/dependencies-0%20%2B%201%20optional-181717)](package.json)

Your coding agents as little workers in a pixel-art office, on the 21st floor in Rio de Janeiro, Dubai, London, New York, Tokyo or Warsaw.

Every Claude Code, Codex, Cursor or other agent session you run gets a desk. You can see at a glance who is working, who is waiting on you, and who just broke the tests.

![The Rio office: desks for each project, the glass cloud-room for sandboxes, Sugarloaf and Christ the Redeemer through the glass, a passer-by in the Brazil kit and the live activity feed](docs/office-rio.png)

## Use

You need Node 18 or newer (and git). No clone needed, it installs straight from GitHub:

```sh
npx github:pvgomes/agent-visualizer          # open the office with your real agents
npx github:pvgomes/agent-visualizer --demo   # a busy pretend office, to look around
```

Or install it once and use the short command (needed for `agent-visualizer install`, below). npm builds it from GitHub into a package file, then installs that:

```sh
npm pack github:pvgomes/agent-visualizer        # writes pvgomes-agent-visualizer-<version>.tgz here
npm install -g ./pvgomes-agent-visualizer-*.tgz
agent-visualizer
```

(`npm install -g github:pvgomes/agent-visualizer` in one step doesn't work: current npm links global installs from git to a temporary folder it then deletes.)

The first run builds the CLI, so it takes a minute; later runs start at once.

> An npm package (`npx @pvgomes/agent-visualizer`) is coming soon.

Your browser opens `http://127.0.0.1:4747`. Start an agent in any terminal and it walks into the office; quit it and it leaves.

## What you see

- **A desk per project**, a worker per agent session, and interns for subagents.
- **A raised hand** means the agent is waiting on you.
- **A flipped table** means a test just failed.
- **The TV** counts workers, tool calls and flips.
- **Change location** (next to Add agent, or `L`) moves the office to Rio de Janeiro (the default), Dubai, London, New York, Tokyo or Warsaw.
- **The clock** shows the city's time; the strip under the TV shows yours.
- **The view** follows the time in that city: dawn, day, sunset and night.

![Change location: Rio de Janeiro, Dubai, London, New York, Tokyo and Warsaw, each with a live postcard of its view and its local time](docs/locations.png)

Works with Claude Code, Codex, Command Code, opencode, Cursor (the editor and cursor-agent), GitHub Copilot (VS Code and the Copilot CLI), Droid, Qwen Code and Gemini CLI. Agents running inside your editor show up just like the ones in a terminal.

## More

- **Add agent** on the page starts an agent from the office and gives you its terminal.
- `agent-visualizer install` lets your agents talk to the office (an MCP server and a skill); `agent-visualizer uninstall` removes it.
- `agent-visualizer --name "Paulo"` puts your name on the office TV.
- `agent-visualizer --herd` shows your [herdr](#with-herdr) herd instead of every agent on the machine.
- `agent-visualizer --help` lists every option, for example `--port`, `--no-open` or `--no-control` (watch only).

Everything runs on your machine. The page shows labels like "Read router.ts", never your prompts, file contents or keys.

## With herdr

[herdr](https://herdr.dev) is a terminal workspace manager for coding agents. When it runs, the office talks to it over its local socket, and you choose who the office shows:

- **The agents on this machine** (the default, `agent-visualizer`): the office works as it always has, from transcripts and running processes. herdr adds what transcripts can't see: an agent blocked on a permission prompt raises its hand.
- **Your herd** (`agent-visualizer --herd`): herdr decides who is in. Every agent in a herdr pane is a worker, in the pod of its folder, for as long as its pane is open, posed by herdr's state (working, blocked, done, idle). Agents the office reads transcripts for (Claude Code, Codex, Cursor, Copilot, ...) still bring the detail, which tool and which file; agents only herdr knows (Pi, Devin, Amp, ...) show up as plain grey workers named by herdr.

Either way, with controls unlocked:

- **Open in herdr**: the inspector of a worker that runs in a herdr pane has a terminal button that brings that pane forward in herdr.
- **Start in herdr**: in Add agent, on this Mac, tick "Start it in a new herdr workspace" and the agent starts in its own herdr workspace instead of the office's terminal (on by default in herd mode). herdr can start Claude Code, Codex, Copilot, Cursor, opencode, Droid and Gemini.

`--no-herdr` leaves herdr out entirely.

### The herdr plugin

The plugin starts the office when herdr starts (in herd mode) and opens it with a key. You need:

- herdr 0.7.5 or newer
- Node 18 or newer, npm and git (herdr clones this repo and builds it with `npm install`)
- macOS or Linux

```sh
herdr plugin install pvgomes/agent-visualizer
```

Then bind a key in herdr's `config.toml` and reload it (`herdr server reload-config`):

```toml
[[keys.command]]
key = "prefix+o"
type = "plugin_action"
command = "agent-visualizer.open"
description = "open the office"
```

`prefix+o` (or `herdr plugin action invoke agent-visualizer.open`) opens the office in your browser, unlocked, starting it first if it isn't running. Ctrl+click on the office's address in a pane does the same (with herdr's `ui.mouse_capture` on). If an office is already running (say, the background service), the plugin uses it as it is.

Settings go in `office.json` in the plugin's config folder (`herdr plugin config-dir agent-visualizer`):

```json
{ "herd": true, "name": "Paulo", "port": 4747 }
```

`"herd": false` starts the office with the agents on this machine instead; `name` goes on the office TV. The office's log is in the plugin's state folder.

**Publishing it on herdr's side.** herdr's marketplace lists public GitHub repos that carry the `herdr-plugin` topic and a valid `herdr-plugin.toml` (this repo has one at its root); there's no submission or review, and the index refreshes every 30 minutes. So the repo needs the topic once:

```sh
gh repo edit pvgomes/agent-visualizer --add-topic herdr-plugin
```

## From source

```sh
git clone git@github.com:pvgomes/agent-visualizer.git
cd agent-visualizer
npm install                 # installs esbuild etc. and builds dist/
node dist/cli.js --demo
```

MIT licensed, see [LICENSE](LICENSE).


---

Powered by [pvgomes](https://pvgomes.com/).
