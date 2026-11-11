# openclaw-bitbucket

Bitbucket Cloud for [OpenClaw](https://docs.openclaw.ai), in two parts:

- a **skill** for pull requests, review comments and pipelines through
  Atlassian's `twg` CLI. It is the counterpart of OpenClaw's bundled `github`
  skill and sits beside it: the agent decides which one applies from the
  repository's `origin`.
- a **plugin** that gives a shared gateway personal Bitbucket logins. Each
  signed-in person connects their own account on a page the gateway serves,
  and commands in the sessions they own push and open pull requests as them,
  or, with `execLogin` off, only the person does, through the gateway, after
  confirming.

## What is in here

| Path | What it is |
|---|---|
| `index.js`, `lib/` | The plugin: the connect page, the exec environment hook and the gateway's confirmed publish |
| `skills/bitbucket/SKILL.md` | The skill: forge detection, auth, pull requests, comments, pipelines |
| `skills/bitbucket/scripts/git-forge` | Prints `<forge> <owner> <repo>` for a checkout's remote |
| `skills/bitbucket/scripts/bb` | `twg bb` with the login the session was given |
| `skills/bitbucket/scripts/git-credential-bitbucket` | Git credential helper for that login |
| `skills/bitbucket/scripts/publish-intent.mjs` | Carries out a publish intent: pushes the branch, opens or finds the pull request |

## Requirements

- OpenClaw 2026.10.2 or later
- `git`, and [`twg`](https://developer.atlassian.com/cloud/twg-cli/getting-started/installation/)
  (the Atlassian CLI) on the gateway's `PATH`.
  `twg` ships for Linux x64 only; on another architecture the skill's
  `twg bb` commands are unavailable, and `publish-intent.mjs` still pushes
  and opens pull requests with a session's login
- for personal logins: a gateway sign-in that identifies each person, such as
  trusted-proxy auth. With a shared token the gateway cannot tell people apart.

Session-owner reads use the asynchronous SDK on newer hosts. The declared
2026.10.2 minimum remains supported by selecting its legacy method only when
the async method is absent. A failed async read never retries through the
legacy API; execution receives no login if its owner cannot be resolved.

## Install

Pin a tag; a plugin runs inside the gateway and a skill is instructions an
agent will follow.

```bash
openclaw plugins install git:github.com/lcorneliussen/openclaw-bitbucket@v0.3.5 --accept-capabilities
```

The plugin brings the skill with it. `openclaw plugins reload bitbucket` loads
it into a running gateway without a restart. Keep the
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

### Upgrade

Install the new tag over the old one and reload it. People's logins and the
plugin's configuration stay as they are.

```bash
openclaw plugins install git:github.com/lcorneliussen/openclaw-bitbucket@<tag> --force --accept-capabilities
openclaw plugins reload bitbucket
```

## Personal logins

1. Open **Bitbucket** in the Control UI sidebar. The page shows whether a token
   is saved and checks its permissions once on opening when you have write access.
   Read-only connections show saved status and the last recorded check, without
   dispatching that check operation. Choose **Connect Bitbucket** or **Replace
   token…** to enter an Atlassian account e-mail and a scoped Bitbucket API token.
   The status card uses labelled account/token fields and individual permission
   rows: Granted, Missing or Unknown. It shows only scopes actually reported by
   Bitbucket; additional reported grants are grouped as not required by this
   plugin. Saved scope results are labelled separately from current verification.
   Each row exposes its exact scope identifier in its title and accessible name.
   The creation instructions and scope checklist stay visible in that form.
   Cancel returns to status and clears the entered token. **Disconnect…** asks
   for confirmation before removing your saved login. Sign in to OpenClaw first. Old
   `/plugins/bitbucket/connect` links redirect to this native page. The form
   uses the authenticated Gateway connection; it does not submit through an
   external plugin frame. The page links to
   [Atlassian API tokens](https://id.atlassian.com/manage-profile/security/api-tokens).
   Choose **Create API token with scopes**, then **Bitbucket**, with:

   - `read:user:bitbucket` (the identity check)
   - `read:repository:bitbucket` and `write:repository:bitbucket`
   - `read:pullrequest:bitbucket` and `write:pullrequest:bitbucket`
   - `read:pipeline:bitbucket`

   These [API-token scopes](https://support.atlassian.com/bitbucket-cloud/docs/api-token-permissions/)
   are independent: write does not implicitly include read. The creation link
   opens token management; Bitbucket-specific scope preselection has not been
   verified, so the page supplies the checklist explicitly.

   The gateway checks identity using one read-only API request. When Bitbucket
   supplies a usable granted-scope list, missing required scopes are named and
   the replacement is refused without overwriting an existing login. Without
   that metadata the page says **Permissions unverified**, rather than
   claiming write access was checked. Repository/branch permissions still apply.

   **Check again** rechecks the signed-in person's saved token; no token
   is sent back to the browser or accepted from that form. The timestamped
   result stays in the owner's private login file. Old login files remain
   usable and show that permissions have not been checked. The opening check
   does not poll Bitbucket, and simultaneous checks for one person are refused. A failed current check is shown as needing attention,
   even when an older saved check had verified all scopes.
   If the existing login file is unreadable, replacement is refused to preserve
   it; repair the file or its permissions before reconnecting. If saving a
   completed check fails, the page shows the fresh result as unsaved, while the
   previously saved credential and metadata stay unchanged.
   A check interrupted by Disconnect or credential replacement cannot attach
   its result to the replacement login. An unreadable saved login is shown as
   such, with operator-repair guidance instead of a new connection form.
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

Connection metadata is read through `bitbucket.connection.get` with
`operator.read`. `bitbucket.connection.connect` (e-mail and token), `.check`
and `.disconnect` require `operator.write` and use the authenticated
requester's profile; no submitted profile ID is accepted. Responses contain
account metadata and permission-check results, never the saved token. The
password input is cleared on submission and on view disposal. Connecting,
checking and disconnecting share one per-profile operation coordinator.

The legacy URL is only a static GET/HEAD redirect. It neither reads saved
logins nor accepts credential POSTs. OpenClaw's external-plugin cookie grant
remains read-only: GET/HEAD access does not authorize a mutation.

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

The native page shows your connection and token-permission status and supports
connect, replacement, permission check and disconnect. It uses the Control UI's
authenticated parent connection, so it works without third-party frame cookies.
A read-only connection can see its own account metadata but cannot change the
login. Set `controlUiTab` to `false` to hide its sidebar navigation; this does
not change Gateway method authorization or remove an existing login.

## Publishing from the gateway

The plugin can publish a session's managed worktree itself, as the person
who asks and only once they confirm. It is the counterpart of OpenClaw's
`sessions.github.publish` with a personal GitHub connection: the token stays
in the gateway and the agent takes no part. A Control UI calls three session
actions with `plugins.sessionAction` (`pluginId: "bitbucket"`):

| Action | Payload | Answer |
|---|---|---|
| `publish-options` | `{dest?}` | your account, or `null`, and the worktree's repository, branch, head and destination |
| `publish` | `{dest?, title?, description?, draft?}` | `needs_confirmation` with a `requestId` and a `confirmation` naming the account, branch, commit, destination, proposed title/description and a `requestDigest`; `not_connected` without a login |
| `publish-confirm` | `{requestId, requestDigest}` | `published` with the pull request's `url`, `number` and whether it was `created` |

The login is the signed-in person's own, never the session owner's or the
gateway's. Only the person who asked can confirm, within ten minutes, once,
and only while the worktree is still on the confirmed commit. Confirming
pushes that commit to the worktree's branch without forcing, then finds the
open pull request into the destination (the repository's main branch unless
named) or opens one, a draft unless `draft` is `false`. The token never meets
the worktree's git config or hooks, which the agent can change: the commit is
fetched into a repository of the gateway's own and pushed from there to the
confirmed repository's https URL. Nothing is
committed: uncommitted files stay behind. Nothing reads file contents in
the worktree either, so no filter driver its config names runs on the
gateway.
When origin has commits the branch lacks, the push fails and says to catch up.
Version 0.3.4 and later accepts a Markdown `description`, preserves its exact
text in the confirmation and binds it into the request digest. It is used only
when creating a pull request. Publishing to an existing PR preserves its title
and description, including human edits. Older callers may omit the description.
After a successful push, the checkout's remote-tracking branch records the
confirmed commit so status can distinguish pushed commits from new local work.
This happens before the pull-request API calls, which can fail independently.
Concurrent tracking updates are preserved. If the push succeeds but its local
record cannot be updated, the published response includes a `warning` with a
recovery step; pull-request creation continues.

Set `execLogin` to `false` so that this is the only way to push. Commands in
people's sessions then still commit as their owner but get no login, and the
skill tells the agent to leave publishing to the person. Login files remain
readable by the gateway's OS user, so this is a rule for agents that follow
the skill, not isolation; sandboxes are (see above).

## Configuration

`plugins.entries.bitbucket.config`:

| Key | Default | Meaning |
|---|---|---|
| `gitIdentity` | `true` | Set the Git author and committer to the session owner's Bitbucket account |
| `execLogin` | `true` | Give commands in a person's sessions their login. `false`: only the gateway's confirmed publish pushes |
| `controlUiTab` | `true` | Show the Bitbucket tab in the Control UI |

## Development

```bash
npm test
```

`npm test` uses a local bare repository and a fake API. The gateway publish
also has a test against real Bitbucket, skipped unless it is given a
throwaway repository and an API token with read and write on repositories
and pull requests:

```bash
BITBUCKET_LIVE_REPO=<workspace>/<throwaway-repo> \
BITBUCKET_LIVE_USER=<account e-mail> BITBUCKET_LIVE_TOKEN=<API token> \
  node --test test/publish.live.test.js
```

It pushes a branch `openclaw/live-<time>`, publishes twice into one draft
pull request, checks that a branch moved on Bitbucket is not forced, then
declines the pull request and deletes the branch.

Optional browser evidence uses a separately installed Playwright module:

```sh
node tools/check-account-ui.mjs PLAYWRIGHT_MODULE OUTPUT_DIRECTORY
```

Pass the module entry path and an output directory as the two arguments. The
checker uses synthetic accounts, writes dark/light screenshots at
320/390/960 pixels across nine account states. It asserts one opening check,
explicit replacement, token clearing, disconnect confirmation and cancellation,
visible scoped-token help in the form, no horizontal overflow and stable
feedback. It contacts no Bitbucket API or live gateway and is separate from the Node test suite.

## License

MIT
