# openclaw-bitbucket

Bitbucket Cloud for [OpenClaw](https://docs.openclaw.ai), in two parts:

- a **skill** for pull requests, review comments and pipelines through
  Atlassian's `twg` CLI. It is the counterpart of OpenClaw's bundled `github`
  skill and sits beside it: the agent decides which one applies from the
  repository's `origin`.
- a **plugin** that gives a shared gateway personal Bitbucket logins. Each
  signed-in person connects their own account on a page the gateway serves,
  and commands in the sessions they own push and open pull requests as them.

## What is in here

| Path | What it is |
|---|---|
| `index.js`, `lib/` | The plugin: the connect page and the exec environment hook |
| `skills/bitbucket/SKILL.md` | The skill: forge detection, auth, pull requests, comments, pipelines |
| `skills/bitbucket/scripts/git-forge` | Prints `<forge> <owner> <repo>` for a checkout's remote |
| `skills/bitbucket/scripts/bb` | `twg bb` with the login the session was given |
| `skills/bitbucket/scripts/git-credential-bitbucket` | Git credential helper for that login |

## Requirements

- OpenClaw 2026.10.2 or later
- `git`, and [`twg`](https://developer.atlassian.com/cloud/twg-cli/getting-started/installation/)
  (the Atlassian CLI) on the gateway's `PATH`
- for personal logins: a gateway sign-in that identifies each person, such as
  trusted-proxy auth. With a shared token the gateway cannot tell people apart.

## Install

Pin a tag; a plugin runs inside the gateway and a skill is instructions an
agent will follow.

```bash
openclaw plugins install git:github.com/lcorneliussen/openclaw-bitbucket@v0.2.0 --accept-capabilities
```

The plugin brings the skill with it. Restart the gateway afterwards. Keep the
`github` skill enabled if the agent also works on GitHub repositories, and
make the routing explicit in the agent's `AGENTS.md`:

> Before pull request, review or CI work, run the `bitbucket` skill's
> `git-forge` on the checkout. `bitbucket` uses the bitbucket skill, `github`
> uses the github skill.

Tell git on the gateway host where pushes get their password, once:

```bash
git config --system credential.https://bitbucket.org.helper \
  /path/to/skills/bitbucket/scripts/git-credential-bitbucket
```

The helper answers only when a session has a login and stays silent
otherwise, so it can be listed before another helper. Without this line the
skill passes the helper on the command line when a push is refused.

The skill alone, without the plugin, is `skills/bitbucket/`: copy it into a
directory named in `skills.load.extraDirs`. The tag `v0.1.0` still installs
with `openclaw skills install`.

## Personal logins

1. A person opens `/plugins/bitbucket/connect` on the gateway's address, or
   the Bitbucket tab in the Control UI, and enters their Atlassian account
   e-mail and a Bitbucket API token (repositories and pull requests read and
   write, pipelines read). The gateway checks the token with Bitbucket and
   stores it under that person's gateway profile.
2. Before every `exec`, the gateway asks the plugin for environment. The
   plugin looks up who the session belongs to (the assigned owner, otherwise
   the signed-in person who created it; a spawned session follows its parent)
   and answers with that person's login:

   | Variable | Value |
   |---|---|
   | `BITBUCKET_LOGIN_FILE` | path of the owner's login file; empty when they have none |
   | `BITBUCKET_USER`, `TWG_BBC_USER` | the account e-mail |
   | `GIT_AUTHOR_*`, `GIT_COMMITTER_*` | the account's name and e-mail |
   | `BITBUCKET_CONNECT_PATH` | where to connect |

3. `bb` and the git credential helper read the token from that file.

The token is never placed in the environment: OpenClaw records plugin-supplied
environment in approval and audit metadata. The agent does not choose the
identity either. Plugin values override anything a command passes in `env`, so
`BITBUCKET_LOGIN_FILE` always names the owner's file or nothing.

### What this does and does not protect

- It decides **whose login a command gets**, in the gateway, from the
  session's owner. It replaces "the agent picks a login".
- It is **not isolation between people**. Login files are private to the
  gateway's OS user (mode 0600), and every command the agent runs is that
  user. A command can read another person's file if it goes looking. Use
  OpenClaw sandboxes or separate hosts where people must not trust each
  other.
- It covers OpenClaw's own `exec` on the gateway host. Sandboxed and node
  execs get an empty `BITBUCKET_LOGIN_FILE`, and a harness's native shell
  does not pass through this hook at all.
- Disconnecting deletes the token from the gateway. It does not revoke it at
  Atlassian.

### The Control UI tab

The tab shows whether you are connected. OpenClaw renders plugin pages in a
read-only frame, so the form is hidden there and the page asks you to open it
in its own browser tab. Behind a sign-in proxy whose session cookie is not
sent to framed pages, the tab does not load at all; the direct address still
works. Set `controlUiTab` to `false` to hide it.

## Configuration

`plugins.entries.bitbucket.config`:

| Key | Default | Meaning |
|---|---|---|
| `gitIdentity` | `true` | Set the Git author and committer to the session owner's Bitbucket account |
| `controlUiTab` | `true` | Show the Bitbucket tab in the Control UI |

## Development

```bash
npm test
```

## License

MIT
