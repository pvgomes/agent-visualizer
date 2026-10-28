# agent-visualizer

[![powered by pvgomes](https://img.shields.io/badge/powered%20by-pvgomes-181717)](https://pvgomes.com/)
[![npm](https://img.shields.io/npm/v/@pvgomes/agent-visualizer?color=181717)](https://www.npmjs.com/package/@pvgomes/agent-visualizer)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-181717?logo=typescript&logoColor=white)](tsconfig.json)
[![zero dependencies](https://img.shields.io/badge/dependencies-0%20%2B%201%20optional-181717)](package.json)

Your coding agents as little workers in a pixel-art office, on the 21st floor in Rio de Janeiro, Dubai, London, New York, Tokyo or Warsaw.

Every Claude Code, Codex, Cursor or other agent session you run gets a desk. You can see at a glance who is working, who is waiting on you, and who just broke the tests.

![The Rio office: desks for each project, the cloud wing for sandboxes, Christ the Redeemer through the glass and a passer-by doing keepie-uppies](docs/office.png)

## Use

You need Node 18 or newer. No clone, no install:

```sh
npx @pvgomes/agent-visualizer          # open the office with your real agents
npx @pvgomes/agent-visualizer --demo   # a busy pretend office, to look around
```

Or install it once and use the short command:

```sh
npm install -g @pvgomes/agent-visualizer
agent-visualizer
```

Your browser opens `http://127.0.0.1:4747`. Start an agent in any terminal and it walks into the office; quit it and it leaves.

## What you see

- **A desk per project**, a worker per agent session, and interns for subagents.
- **A raised hand** means the agent is waiting on you.
- **A flipped table** means a test just failed.
- **The TV** counts workers, tool calls and flips.
- **Change location** (next to Hire, or `L`) moves the office to Rio de Janeiro (the default), Dubai, London, New York, Tokyo or Warsaw.
- **The clock** shows the city's time; the strip under the TV shows yours.
- **The view** follows the time in that city: dawn, day, sunset and night.

Works with Claude Code, Codex, Command Code, opencode, Cursor, Droid, Qwen Code and Gemini CLI.

## More

- **Hire** on the page starts an agent from the office and gives you its terminal.
- `agent-visualizer install` lets your agents talk to the office (an MCP server and a skill); `agent-visualizer uninstall` removes it.
- `agent-visualizer --help` lists every option, for example `--port`, `--no-open` or `--no-control` (watch only).

Everything runs on your machine. The page shows labels like "Read router.ts", never your prompts, file contents or keys.

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
