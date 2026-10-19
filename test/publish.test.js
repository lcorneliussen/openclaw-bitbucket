import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { writeLogin } from "../lib/logins.js";
import { createPublisher, parseBitbucketRemote } from "../lib/publish.js";

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const ORIGIN = "https://bitbucket.org/example-ws/docs.git";

// A worktree on openclaw/add-thing whose origin "is" Bitbucket: git is told to
// use a local bare repository instead of that URL.
async function fixture({ connected = true } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "bitbucket-publish-"));
  const bare = path.join(root, "origin.git");
  const work = path.join(root, "work");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  git(work, "config", "user.email", "ada@example.com");
  git(work, "config", "user.name", "Ada");
  git(work, "remote", "add", "origin", ORIGIN);
  const gitEnv = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.${bare}.insteadOf`, GIT_CONFIG_VALUE_0: ORIGIN };
  await writeFile(path.join(work, "a.txt"), "a\n");
  git(work, "add", "a.txt");
  git(work, "commit", "-qm", "Start");
  execFileSync("git", ["-C", work, "push", "-q", "origin", "main"], { env: { ...process.env, ...gitEnv } });
  git(work, "switch", "-qc", "openclaw/add-thing");
  await writeFile(path.join(work, "b.txt"), "b\n");
  git(work, "add", "b.txt");
  git(work, "commit", "-qm", "Add the thing");

  const stateDir = path.join(root, "state");
  if (connected) {
    await writeLogin(stateDir, { profile: "ada", user: "ada@example.com", name: "Ada Example", token: "secret-token", stored: "2026-01-01T00:00:00.000Z" });
    await writeLogin(stateDir, { profile: "bob", user: "bob@example.com", name: "Bob", token: "bob-token", stored: "2026-01-01T00:00:00.000Z" });
  }
  const calls = [];
  const open = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, auth: init.headers.authorization, body: init.body && JSON.parse(init.body) });
    const value = /\/repositories\/[^/]+\/[^/?]+$/.test(url)
      ? { mainbranch: { name: "main" } }
      : init.method === "GET"
      ? { values: open }
      : { id: 7, links: { html: { href: "https://bitbucket.org/example-ws/docs/pull-requests/7" } } };
    return new Response(JSON.stringify(value), { status: init.method === "GET" ? 200 : 201 });
  };
  let profileId = "ada";
  const clock = { t: Date.now() };
  const publisher = createPublisher({
    stateDir,
    getSessionEntry: async ({ sessionKey }) => (sessionKey === "repo-session" ? { worktree: { branch: "openclaw/add-thing" }, workspaceDir: work } : undefined),
    currentProfile: () => (profileId ? { profileId } : undefined),
    fetchImpl,
    gitEnv,
    apiUrl: "https://api.test/2.0",
    now: () => clock.t,
  });
  return { work, bare, publisher, calls, open, now: clock, as: (id) => { profileId = id; } };
}

const ask = (p, payload = {}) => p.publish({ sessionKey: "repo-session", agentId: "main", payload });
const confirm = (p, out, extra = {}) =>
  p.confirm({ sessionKey: "repo-session", agentId: "main", payload: { requestId: out.result.requestId, requestDigest: out.result.confirmation.requestDigest, ...extra } });

test("Bitbucket remotes are recognized in their https and ssh forms", () => {
  assert.deepEqual(parseBitbucketRemote("https://bitbucket.org/ws/repo.git"), { owner: "ws", repo: "repo" });
  assert.deepEqual(parseBitbucketRemote("https://someone@bitbucket.org/ws/repo"), { owner: "ws", repo: "repo" });
  assert.deepEqual(parseBitbucketRemote("git@bitbucket.org:ws/repo.git"), { owner: "ws", repo: "repo" });
  assert.equal(parseBitbucketRemote("https://github.com/ws/repo.git"), undefined);
});

test("asking pushes nothing; confirming pushes the branch and opens a draft pull request as the person who asked", async () => {
  const f = await fixture();
  const out = await ask(f.publisher);
  assert.equal(out.ok, true, out.error);
  assert.equal(out.result.status, "needs_confirmation");
  const c = out.result.confirmation;
  assert.equal(c.account, "ada@example.com");
  assert.equal(c.branch, "openclaw/add-thing");
  assert.equal(c.dest, "main");
  assert.equal(c.title, "Add the thing");
  assert.equal(c.head, git(f.work, "rev-parse", "HEAD"));
  assert.equal(git(f.bare, "branch", "--list", "openclaw/add-thing"), "", "nothing is pushed before confirming");
  assert.equal(f.calls.filter((c) => /pullrequests/.test(c.url)).length, 0, "no pull request is asked for before confirming");

  const done = await confirm(f.publisher, out);
  assert.equal(done.ok, true, done.error);
  assert.equal(done.result.status, "published");
  assert.equal(done.result.url, "https://bitbucket.org/example-ws/docs/pull-requests/7");
  assert.equal(done.result.created, true);
  assert.equal(git(f.bare, "rev-parse", "openclaw/add-thing"), c.head);
  const [query, create] = f.calls.filter((c) => /pullrequests/.test(c.url));
  assert.match(query.url, /^https:\/\/api\.test\/2\.0\/repositories\/example-ws\/docs\/pullrequests\?q=/);
  assert.match(decodeURIComponent(query.url), /source\.repository\.full_name="example-ws\/docs"/, "a fork's pull request is not reused");
  assert.equal(create.method, "POST");
  assert.deepEqual(create.body, { title: "Add the thing", draft: true, source: { branch: { name: "openclaw/add-thing" } }, destination: { branch: { name: "main" } } });
  assert.equal(create.auth, "Basic " + Buffer.from("ada@example.com:secret-token").toString("base64"));

  const again = await confirm(f.publisher, out);
  assert.equal(again.ok, false, "a confirmation is used once");
});

test("without a login of their own, the person is told to connect", async () => {
  const f = await fixture({ connected: false });
  assert.deepEqual((await ask(f.publisher)).result, { status: "not_connected" });
  f.as(undefined);
  const out = await ask(f.publisher);
  assert.equal(out.ok, false);
  assert.match(out.error, /sign in as a person/);
});

test("only the person who asked confirms, and only what they were shown", async () => {
  const f = await fixture();
  const out = await ask(f.publisher);
  assert.match((await confirm(f.publisher, out, { requestDigest: "0".repeat(64) })).error, /does not match/);
  f.as("bob");
  assert.match((await confirm(f.publisher, out)).error, /only the person who asked/);
  f.as("ada");
  await writeFile(path.join(f.work, "c.txt"), "c\n");
  git(f.work, "add", "c.txt");
  git(f.work, "commit", "-qm", "More");
  assert.match((await confirm(f.publisher, out)).error, /moved on/);
  assert.equal(git(f.bare, "branch", "--list", "openclaw/add-thing"), "");
});

test("a branch origin has moved is not forced: the person is told to catch up", async () => {
  const f = await fixture();
  const first = await ask(f.publisher);
  assert.equal((await confirm(f.publisher, first)).ok, true);
  git(f.work, "reset", "-q", "--hard", "HEAD~1");
  await writeFile(path.join(f.work, "d.txt"), "d\n");
  git(f.work, "add", "d.txt");
  git(f.work, "commit", "-qm", "Diverged");
  const out = await ask(f.publisher);
  const res = await confirm(f.publisher, out);
  assert.equal(res.ok, false);
  assert.match(res.error, /catch up/);
});

test("a title can be given", async () => {
  const f = await fixture();
  await writeFile(path.join(f.work, "notes.txt"), "draft\n");
  const out = await ask(f.publisher, { title: "Custom title" });
  assert.equal(out.result.confirmation.title, "Custom title");
  assert.equal("uncommitted" in out.result.confirmation, false);
});

test("a session without a worktree, or with a GitHub origin, is refused", async () => {
  const f = await fixture();
  const res = await f.publisher.publish({ sessionKey: "other", agentId: "main", payload: {} });
  assert.match(res.error, /no managed worktree/);
  git(f.work, "remote", "set-url", "origin", "https://github.com/example/docs.git");
  assert.match((await ask(f.publisher)).error, /not a Bitbucket repository/);
});

test("a request expires after ten minutes, and nothing is pushed then", async () => {
  const f = await fixture();
  const out = await ask(f.publisher);
  f.now.t += 10 * 60_000 + 1;
  assert.match((await confirm(f.publisher, out)).error, /expired/);
  assert.equal(git(f.bare, "branch", "--list", "openclaw/add-thing"), "");
});

test("an open pull request is found, not opened again, and draft: false opens a ready one", async () => {
  const f = await fixture();
  f.open.push({ id: 5, links: { html: { href: "https://bitbucket.org/example-ws/docs/pull-requests/5" } } });
  const done = await confirm(f.publisher, await ask(f.publisher));
  assert.equal(done.result.created, false);
  assert.equal(done.result.number, 5);
  assert.equal(f.calls.some((c) => c.method === "POST"), false);
  f.open.length = 0;
  await writeFile(path.join(f.work, "e.txt"), "e\n");
  git(f.work, "add", "e.txt");
  git(f.work, "commit", "-qm", "Ready");
  await confirm(f.publisher, await ask(f.publisher, { draft: false }));
  assert.equal(f.calls.find((c) => c.method === "POST").body.draft, false);
});

test("the worktree's git config and hooks do not take part in the push", async () => {
  const f = await fixture();
  const marker = path.join(f.work, "..", "hook-ran");
  // A pre-push hook and a push URL elsewhere, as an agent could set them.
  await writeFile(path.join(f.work, ".git", "hooks", "pre-push"), `#!/bin/sh\ntouch ${marker}\nexit 1\n`, { mode: 0o755 });
  git(f.work, "config", "remote.origin.pushurl", path.join(f.work, "..", "elsewhere.git"));
  const done = await confirm(f.publisher, await ask(f.publisher));
  assert.equal(done.ok, true, done.error);
  assert.equal(git(f.bare, "rev-parse", "openclaw/add-thing"), git(f.work, "rev-parse", "HEAD"));
  await assert.rejects(stat(marker), "the worktree's pre-push hook did not run");
});

test("origin repointed after asking is refused", async () => {
  const f = await fixture();
  const out = await ask(f.publisher);
  git(f.work, "remote", "set-url", "origin", "https://bitbucket.org/example-ws/public-copy.git");
  assert.match((await confirm(f.publisher, out)).error, /moved on/);
});

test("reading the worktree runs none of its filter drivers", async () => {
  const f = await fixture();
  const marker = path.join(f.work, "..", "filter-ran");
  git(f.work, "config", "filter.evil.clean", `touch ${marker}; cat`);
  await writeFile(path.join(f.work, ".gitattributes"), "*.txt filter=evil\n");
  git(f.work, "add", ".gitattributes");
  git(f.work, "commit", "-qm", "Attributes");
  // Make a tracked file stat-dirty, which git status would run the filter for.
  await writeFile(path.join(f.work, "a.txt"), "a\n");
  await rm(marker, { force: true });
  const out = await ask(f.publisher);
  assert.equal(out.ok, true, out.error);
  await assert.rejects(stat(marker), "the worktree's clean filter did not run");
  assert.equal((await confirm(f.publisher, out)).ok, true);
  await assert.rejects(stat(marker));
});

test("a push Bitbucket refuses for another reason says why, not to catch up", async () => {
  const f = await fixture();
  await writeFile(path.join(f.bare, "hooks", "pre-receive"), "#!/bin/sh\necho 'branch is protected' >&2\nexit 1\n", { mode: 0o755 });
  const res = await confirm(f.publisher, await ask(f.publisher));
  assert.equal(res.ok, false);
  assert.match(res.error, /git push failed: .*branch is protected/);
  assert.doesNotMatch(res.error, /catch up/);
});

test("reading the worktree runs no signature program from its config", async () => {
  const f = await fixture();
  const marker = path.join(f.work, "..", "gpg-ran");
  const program = path.join(f.work, "..", "fake-gpg");
  await writeFile(program, `#!/bin/sh\ntouch ${marker}\nexit 1\n`, { mode: 0o755 });
  git(f.work, "config", "log.showSignature", "true");
  git(f.work, "config", "gpg.program", program);
  // A HEAD with a (forged) signature header, which git log would verify.
  const tree = git(f.work, "rev-parse", "HEAD^{tree}");
  const parent = git(f.work, "rev-parse", "HEAD");
  const signed = `tree ${tree}\nparent ${parent}\nauthor Ada <ada@example.com> 1700000000 +0000\ncommitter Ada <ada@example.com> 1700000000 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n -----END PGP SIGNATURE-----\n\nSigned subject\n`;
  const sha = execFileSync("git", ["-C", f.work, "hash-object", "-t", "commit", "-w", "--stdin"], { input: signed, encoding: "utf8" }).trim();
  git(f.work, "reset", "-q", sha);
  const out = await ask(f.publisher);
  assert.equal(out.ok, true, out.error);
  assert.equal(out.result.confirmation.title, "Signed subject");
  await assert.rejects(stat(marker), "the worktree's gpg.program did not run");
});
