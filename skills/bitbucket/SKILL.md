---
name: bitbucket
description: "Bitbucket Cloud pull requests, review comments, and pipelines through the Atlassian `twg` CLI. Use when a repository's origin is on bitbucket.org. Check the origin first: a github.com origin belongs to the github skill."
metadata: { "openclaw": { "emoji": "🪣", "requires": { "bins": ["twg", "git"] } } }
---

# Bitbucket

Use `twg bb` for Bitbucket Cloud. Use `git` for local commits, branches, push
and pull. This is the counterpart of the `github` skill: same jobs, another
forge.

## Which forge

Decide from the repository, not from the request. Before any pull request,
review or CI work in a checkout:

```bash
{baseDir}/scripts/git-forge          # prints: <forge> <owner> <repo>
```

| First word | Use |
|---|---|
| `bitbucket` | this skill; `<owner>` is the workspace slug |
| `github` | the `github` skill (`gh`) |
| `unknown` | neither; say which host it is and ask |

A task that spans repositories checks each one. Never run `gh` against a
Bitbucket repository or `twg bb` against a GitHub one because the previous
repository used it.

`twg bb` detects the workspace and repository from the checkout's remote.
Outside a checkout, pass `--workspace <slug> --repo <slug>`.

## Auth

`twg bb` needs a Bitbucket API token (scopes: repositories and pull requests,
read and write; pipelines read for CI). `git push` over HTTPS uses the same
token as the password, with the user name `x-bitbucket-api-token-auth`.

Check the environment first:

```bash
echo "${BITBUCKET_LOGIN_FILE-unset} ${BITBUCKET_PUBLISH-}"
```

When the second word is `gateway`, this gateway keeps Bitbucket logins out of
agents' commands: you have no login to push, comment or open pull requests
with, and must not look for one. Commit the work; the person pushes it and
opens the pull request from the Control UI, where the gateway asks them to
confirm. Tell them what is ready to publish.

| Result | Meaning |
|---|---|
| a path | The gateway gave this session its owner's login. Run `{baseDir}/scripts/bb …` wherever this page says `twg bb …`. `git` commits as that person. |
| empty | The gateway has personal logins, and the person this session belongs to has not connected one. Do not look for another login. Tell them to open `$BITBUCKET_CONNECT_PATH` on the gateway's address in their browser, connect, and ask again. |
| `unset` | No personal logins here. `twg` takes the token from `TWG_BBC_USER` and `TWG_BBC_TOKEN`, or from `twg setup bitbucket`. |

With a login file, `git push` and `git fetch` normally just work. If git
reports that authentication failed, the machine has no credential helper
configured for it; name the helper for that one command:

```bash
git -c credential.https://bitbucket.org.helper= \
    -c credential.https://bitbucket.org.helper="{baseDir}/scripts/git-credential-bitbucket" \
    push -u origin <branch>
```

- The login belongs to one person. Never read the file, copy it, or point a
  command at a different one, and never set `BITBUCKET_LOGIN_FILE` yourself.
- Never ask for a token in chat, echo one, or pass one as a command argument.
- Check before you write: `twg bb repo get -o json` fails with
  `AUTH_INVALID` when no usable token is present.
- Pull requests and comments appear under the token's account.

## Pull requests

```bash
twg bb prs query                                   # open PRs in this repository
twg bb prs query --state MERGED --since 7d
twg bb prs query --scope me --role reviewer        # waiting for your review
twg bb prs get 42 --full -o json                   # description, commits, comments
twg bb prs get 42 --statuses                       # build results on the PR
twg bb prs diffstat 42
twg bb prs diff 42
twg bb prs mergeability 42                         # what blocks the merge
twg bb prs conflicts 42
```

Create one after pushing the branch:

```bash
git push -u origin <branch>
twg bb prs create --title "<what changed>" --source <branch> --dest main \
  --description-file /tmp/pr.md -o json
```

Add `--draft` for work that is not ready for review. Write the description to
a file with real newlines; `--description` takes one line. The JSON result
carries the pull request's number and URL: give the URL to the person.

Update and decide:

```bash
twg bb prs update --pull-request 42 --title "<new title>"
twg bb prs approve 42
twg bb prs request-changes 42
twg bb prs merge --pull-request 42 --merge-strategy squash --wait
twg bb prs decline 42
```

Merging and declining are hard to undo. Do them only when asked, and after
`mergeability` shows nothing blocking. Run `<command> --help` for options this
page does not list.

## Publish intents

A tool that cannot publish from where it runs may hand you the publication as
JSON instead: a plan with `intents`, or one intent. `wtc publish` does this
inside an OpenClaw agent's shell:

```json
{ "host": "openclaw", "version": 1, "action": "publish", "actor": "repo-session",
  "repo": "docs", "forge": "bitbucket",
  "args": { "owner": "example-ws", "repo": "docs",
            "source": "openclaw/72-add-thing", "dest": "main",
            "title": "Add thing", "draft": true } }
```

An intent with `"forge": "bitbucket"` and no `tool` is this skill's to carry
out. One with a `tool` (`github_publish`) is not: call that tool.

Run it in the session that owns the repository (`actor` is `repo-session`),
with the work committed. Pipe the plan in, or name a file that holds it:

```bash
wtc publish --title "<what changed>" | {baseDir}/scripts/publish-intent.mjs
{baseDir}/scripts/publish-intent.mjs --dry-run plan.json     # check only
```

The script pushes `source` and opens the pull request into `dest`, as a draft
when the intent says so, or finds the one already open for that branch. It
uses this session's login as described under Auth, and where `twg` is not
installed it asks Bitbucket directly. It prints
`{status, url, number, branch, dest, created}`: answer with the URL.

It refuses instead of repairing, and so should you:

- **another checkout or branch**: say so and stop; do not switch branches to
  make the intent fit.
- **uncommitted work**: commit what belongs to the change, then run it again.
- **push rejected**: the remote branch has commits this one lacks. Merge
  them and publish again. Never rebase or force-push a published branch:
  other tools that publish from the same checkout refuse rewritten history.

## Review comments

```bash
twg bb prs comment query 42 -o json
twg bb prs comment create --pull-request 42 --text "<comment>"
twg bb prs comment create --pull-request 42 --text "<comment>" --path src/app.py --line 17
twg bb prs comment create --pull-request 42 --text "<reply>" --reply-to <commentId>
```

For an inline comment, get the line number from `twg bb prs diff-line 42`
instead of counting lines in the diff. Answer a review thread with
`--reply-to`, then fix or explain; resolve it only when the point is settled.

## Pipelines

```bash
twg bb pipeline query --branch <branch>            # recent runs
twg bb pipeline latest-failure --branch <branch> --lines 200
twg bb pipeline get --pipeline <build-number> -o json
twg bb pipeline grep "<pattern>" --pipeline <build-number>
twg bb pipeline rerun-failed --pipeline <build-number>
```

A pushed branch only runs a pipeline when `bitbucket-pipelines.yml` matches
it; no run is not a failure. Read `latest-failure` before proposing a fix, and
quote the failing step's lines.

## Differences from GitHub

- A repository is `<workspace>/<repo>`; there is no user namespace.
- There are no issues to rely on: many workspaces keep them in Jira. Ask
  where issues live instead of assuming.
- Pull request states are OPEN, MERGED, DECLINED and SUPERSEDED. A declined
  pull request cannot be reopened.
- Reviewers approve or request changes; there is no single "review" object
  that bundles comments.
- Links look like `https://bitbucket.org/<workspace>/<repo>/pull-requests/<n>`.
