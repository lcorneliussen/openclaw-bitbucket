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
read and write; pipelines read for CI). It takes it from the environment:

```bash
TWG_BBC_USER=<atlassian account e-mail>
TWG_BBC_TOKEN=<api token>
```

or from `twg setup bitbucket`, which asks for it interactively.

`git push` over HTTPS uses the same token as the password, with the user name
`x-bitbucket-api-token-auth`.

- Check before you write: `twg bb repo get -o json` fails with
  `AUTH_INVALID` when no usable token is present.
- Never ask for a token in chat, echo one, or pass one as a command argument.
  If the deployment provides a wrapper that supplies a person's login, run
  every `git` and `twg` command through it.
- Pull requests and comments appear under the token's account. On a shared
  agent, use the login of the person the work is for.

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
