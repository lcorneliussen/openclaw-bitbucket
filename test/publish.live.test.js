// The gateway publish against real Bitbucket: the push from a repository of
// the gateway's own with the person's API token, the main branch from the
// API, and the pull request API. What a signed-in person is comes from the
// gateway and is covered by publish.test.js; here it is given.
//
//   BITBUCKET_LIVE_REPO=<workspace>/<throwaway-repo> \
//   BITBUCKET_LIVE_USER=<account e-mail> BITBUCKET_LIVE_TOKEN=<API token> \
//     node --test test/publish.live.test.js
//
// The token needs read and write on repositories and pull requests. The
// test pushes a branch openclaw/live-<time>, declines the pull requests it
// opened and deletes the branch; it never touches the main branch.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { writeLogin } from "../lib/logins.js";
import { createPublisher } from "../lib/publish.js";

const repo = process.env.BITBUCKET_LIVE_REPO ?? "";
const user = process.env.BITBUCKET_LIVE_USER ?? "";
const token = process.env.BITBUCKET_LIVE_TOKEN ?? "";
const skip = !repo || !user || !token ? "needs BITBUCKET_LIVE_REPO, BITBUCKET_LIVE_USER and BITBUCKET_LIVE_TOKEN" : false;

const api = async (method, url, body) => {
  const response = await fetch(`https://api.bitbucket.org/2.0/repositories/${repo}${url}`, {
    method,
    headers: {
      authorization: "Basic " + Buffer.from(`${user}:${token}`).toString("base64"),
      accept: "application/json",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, json: response.status === 204 ? null : await response.json().catch(() => null) };
};

// Git for the test itself, with the token through the environment only.
const helper = "!f() { [ \"$1\" = get ] && printf 'username=x-bitbucket-api-token-auth\\npassword=%s\\n' \"$LIVE_TOKEN\"; }; f";
const git = (cwd, ...args) =>
  execFileSync("git", ["-C", cwd, "-c", "credential.helper=", "-c", `credential.helper=${helper}`, "-c", "user.name=Live Test", "-c", "user.email=live@example.com", ...args], {
    encoding: "utf8",
    env: { ...process.env, LIVE_TOKEN: token, GIT_TERMINAL_PROMPT: "0" },
  }).trim();

const branch = `openclaw/live-${Date.now()}`;
const opened = new Set();
let root;

after(async () => {
  if (skip) return;
  // The login file holds the real token.
  if (root) await rm(root, { recursive: true, force: true });
  for (const id of opened) {
    const { status } = await api("POST", `/pullrequests/${id}/decline`);
    if (status !== 200) console.error(`declining pull request ${id}: HTTP ${status}; decline it by hand`);
  }
  const { status } = await api("DELETE", `/refs/branches/${encodeURIComponent(branch)}`);
  if (status !== 204 && status !== 404) console.error(`deleting ${branch}: HTTP ${status}; delete it by hand`);
});

test("the gateway publishes a confirmed commit to Bitbucket, into one draft pull request, and never forces", { skip }, async () => {
  root = await mkdtemp(path.join(tmpdir(), "bitbucket-live-"));
  const work = path.join(root, "work");
  git(root, "clone", "-q", `https://bitbucket.org/${repo}.git`, work);
  // Without origin/HEAD the destination has to come from Bitbucket's API.
  git(work, "remote", "set-head", "origin", "-d");
  const mainBranch = (await api("GET", "")).json?.mainbranch?.name;
  assert.ok(mainBranch, "the repository has a main branch");
  git(work, "switch", "-qc", branch);
  await writeFile(path.join(work, "live.txt"), "one\n");
  git(work, "add", "live.txt");
  git(work, "commit", "-qm", "Live test: first commit");

  const stateDir = path.join(root, "state");
  await writeLogin(stateDir, { profile: "live", user, name: "Live Test", token, stored: new Date().toISOString() });
  const publisher = createPublisher({
    stateDir,
    getSessionEntry: async ({ sessionKey }) => (sessionKey === "repo-session" ? { worktree: { branch }, workspaceDir: work } : undefined),
    currentProfile: () => ({ profileId: "live" }),
  });
  const publish = async () => {
    const asked = await publisher.publish({ sessionKey: "repo-session", agentId: "main", payload: { draft: true, title: "Live test of the gateway publish" } });
    assert.equal(asked.ok, true, asked.error);
    assert.equal(asked.result.status, "needs_confirmation");
    return publisher.confirm({ sessionKey: "repo-session", agentId: "main", payload: { requestId: asked.result.requestId, requestDigest: asked.result.confirmation.requestDigest } });
  };

  // The main branch comes from Bitbucket when the clone does not say.
  const options = await publisher.options({ sessionKey: "repo-session", agentId: "main", payload: {} });
  assert.equal(options.ok, true, options.error);
  assert.equal(options.result.repo.dest, mainBranch);
  assert.equal(options.result.account.user, user);

  const first = await publish();
  assert.equal(first.ok, true, first.error);
  // Recorded first, so that it is declined even when an assertion fails.
  if (first.result.number) opened.add(first.result.number);
  assert.equal(first.result.created, true);
  assert.equal(first.result.account, user);
  assert.equal(first.result.dest, mainBranch);
  const pr = await api("GET", `/pullrequests/${first.result.number}`);
  assert.equal(pr.status, 200);
  assert.equal(pr.json.source.branch.name, branch);
  assert.equal(pr.json.draft, true);
  assert.equal(pr.json.source.commit.hash, git(work, "rev-parse", "HEAD").slice(0, pr.json.source.commit.hash.length));

  // A second commit goes into the same pull request.
  await writeFile(path.join(work, "live.txt"), "two\n");
  git(work, "commit", "-qam", "Live test: second commit");
  const second = await publish();
  assert.equal(second.ok, true, second.error);
  assert.equal(second.result.created, false);
  assert.equal(second.result.number, first.result.number);
  const remoteHead = git(work, "ls-remote", "origin", `refs/heads/${branch}`).split(/\s/)[0];
  assert.equal(remoteHead, git(work, "rev-parse", "HEAD"));

  // Someone else moves the branch on Bitbucket: the next publish is not forced.
  const other = path.join(root, "other");
  git(root, "clone", "-q", "--branch", branch, `https://bitbucket.org/${repo}.git`, other);
  await writeFile(path.join(other, "other.txt"), "theirs\n");
  git(other, "add", "other.txt");
  git(other, "commit", "-qm", "Live test: someone else's commit");
  git(other, "push", "-q", "origin", branch);
  await writeFile(path.join(work, "live.txt"), "three\n");
  git(work, "commit", "-qam", "Live test: third commit");
  const diverged = await publish();
  assert.equal(diverged.ok, false);
  assert.match(diverged.error, /catch up/);
  const after = git(work, "ls-remote", "origin", `refs/heads/${branch}`).split(/\s/)[0];
  assert.equal(after, git(other, "rev-parse", "HEAD"), "the other commit is still on Bitbucket");
});
