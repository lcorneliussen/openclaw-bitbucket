# openclaw-bitbucket

An [OpenClaw](https://docs.openclaw.ai) skill for Bitbucket Cloud: pull
requests, review comments and pipelines, through Atlassian's `twg` CLI. It is
the counterpart of OpenClaw's bundled `github` skill and is meant to sit beside
it. The agent decides which one applies from the repository's `origin`, so one
agent can work on GitHub and Bitbucket repositories in the same session.

## What is in here

| Path | What it is |
|---|---|
| `SKILL.md` | The skill: forge detection, auth, pull requests, comments, pipelines |
| `scripts/git-forge` | Prints `<forge> <owner> <repo>` for a checkout's remote |

There is no plugin yet. OpenClaw's GitHub plugin renders link previews beside
the chat; a Bitbucket equivalent would live in this repository next to the
skill.

## Requirements

- `git`
- [`twg`](https://developer.atlassian.com/cloud/twg-cli/getting-started/installation/),
  the Atlassian CLI, on the gateway's `PATH`
- a Bitbucket API token per person or bot, supplied as `TWG_BBC_USER` and
  `TWG_BBC_TOKEN` or stored with `twg setup bitbucket`

## Install

Pin a tag; the skill is instructions an agent will follow.

```bash
openclaw skills install git:lcorneliussen/openclaw-bitbucket@v0.1.0 --as bitbucket
```

Keep the `github` skill enabled if the agent also works on GitHub
repositories. To make the routing explicit, add a line to the agent's
`AGENTS.md`:

> Before pull request, review or CI work, run the `bitbucket` skill's
> `git-forge` on the checkout. `bitbucket` uses the bitbucket skill, `github`
> uses the github skill.

## Credentials on a shared agent

The skill does not store or select credentials. A deployment that serves
several people should wrap `git` and `twg` so each command runs with the
login of the person the work is for, and tell the agent to use that wrapper.
The skill only asks the agent to go through such a wrapper when one exists.

## License

MIT
