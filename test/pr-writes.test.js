import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { writeLogin } from "../lib/logins.js";
import { claimName, createPullRequestWriter, parseRequest, RECEIPTS_DIR, receiptName, REQUEST_FILE } from "../lib/pr-writes.js";

// Network containment: these tests answer every Bitbucket call themselves.
// The global fetch is poisoned so that a call that escapes the injected
// implementation fails the test instead of reaching a real host.
const realFetch = globalThis.fetch;
before(() => { globalThis.fetch = async (url) => { throw new Error(`network escape in a synthetic test: ${url}`); }; });
after(() => { globalThis.fetch = realFetch; });

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const HEAD = "0123456789abcdef0123";

async function fixture({ pr = {}, comments = {}, me = "{ada}", failOn, hangOn, unreadableOn, nonJsonOn } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "bitbucket-pr-writes-"));
  const work = path.join(root, "work");
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  git(work, "remote", "add", "origin", "https://bitbucket.org/example-ws/docs.git");
  const stateDir = path.join(root, "state");
  await writeLogin(stateDir, { profile: "ada", user: "ada@example.com", name: "Ada Example", token: "ada-secret-token", stored: "2026-01-01T00:00:00.000Z" });
  await writeLogin(stateDir, { profile: "bob", user: "bob@example.com", name: "Bob", token: "bob-secret-token", stored: "2026-01-01T00:00:00.000Z" });
  const calls = [];
  let nextComment = 500;
  const fetchImpl = async (url, init) => {
    const route = url.replace("https://api.test/2.0", "");
    calls.push({ route, method: init.method, auth: init.headers.authorization, body: init.body && JSON.parse(init.body), redirect: init.redirect });
    if (!url.startsWith("https://api.test/2.0/")) throw new Error("unexpected host");
    if (hangOn && init.method === hangOn.method && route.endsWith(hangOn.suffix)) throw new TypeError("fetch failed");
    if (nonJsonOn && init.method === nonJsonOn.method && route.endsWith(nonJsonOn.suffix)) return new Response("accepted", { status: 201 });
    if (unreadableOn && init.method === unreadableOn.method && route.endsWith(unreadableOn.suffix)) return { ok: true, status: 201, text: async () => { throw new TypeError("terminated"); } };
    if (failOn && init.method === failOn.method && route.endsWith(failOn.suffix)) return new Response("{}", { status: failOn.status ?? 403 });
    if (route === "/user") return Response.json({ uuid: me });
    const m = route.match(/^\/repositories\/example-ws\/docs\/pullrequests\/(\d+)(\/comments(?:\/(\d+))?(\/resolve)?)?$/);
    if (!m) return new Response("{}", { status: 404 });
    if (!m[2]) {
      if (init.method === "GET") return Response.json({ id: Number(m[1]), state: "OPEN", draft: true, source: { commit: { hash: HEAD.slice(0, 12) } }, destination: { repository: { full_name: "example-ws/docs" } }, ...pr });
      return Response.json({ id: Number(m[1]) });
    }
    if (m[3] && init.method === "GET") return Response.json({ id: Number(m[3]), pullrequest: { id: Number(m[1]) }, user: { uuid: "{ada}" }, ...comments[m[3]] });
    if (m[4]) return new Response(null, { status: 204 });
    if (init.method === "POST") return Response.json({ id: nextComment++ });
    return Response.json({ id: Number(m[3]) });
  };
  let profileId = "ada";
  const writer = createPullRequestWriter({
    stateDir,
    getSessionEntry: async ({ sessionKey }) => (sessionKey === "repo-session" ? { worktree: { branch: "feature" }, workspaceDir: work } : undefined),
    currentProfile: () => (profileId ? { profileId } : undefined),
    fetchImpl,
    apiUrl: "https://api.test/2.0",
  });
  const gitDir = path.join(work, ".git");
  const ask = (request) => writeFile(path.join(gitDir, REQUEST_FILE), JSON.stringify(request));
  return { writer, calls, ask, gitDir, setProfile: (p) => { profileId = p; } };
}

const request = (operations, extra = {}) => ({ version: 1, intentId: "review-0001-abcdef", pr: 7, head: HEAD, operations, ...extra });
const action = (payload = {}) => ({ sessionKey: "repo-session", payload });

test("the person confirms exactly what is written, with their own login, once", async () => {
  const f = await fixture();
  await f.ask(request([
    { op: "comment.create", text: "Summary" },
    { op: "comment.create", text: "Inline", inline: { path: "a.go", to: 3 } },
    { op: "comment.update", comment: 41, text: "Updated" },
    { op: "comment.resolve", comment: 42 },
    { op: "pr.update", title: "New title", description: "Body" },
    { op: "pr.ready" },
  ]));
  const asked = await f.writer.ask(action());
  assert.equal(asked.ok, true, asked.error);
  assert.equal(asked.result.status, "needs_confirmation");
  assert.equal(asked.result.confirmation.account, "ada@example.com");
  assert.equal(asked.result.confirmation.operations.length, 6);
  assert.ok(!f.calls.some((c) => c.method !== "GET"), "asking writes nothing");

  const done = await f.writer.confirm(action({ requestId: asked.result.requestId, requestDigest: asked.result.confirmation.requestDigest }));
  assert.equal(done.ok, true, done.error);
  assert.equal(done.result.status, "done", JSON.stringify(done.result.receipt?.results));
  const writes = f.calls.filter((c) => c.method !== "GET");
  assert.deepEqual(writes.map((c) => `${c.method} ${c.route}`), [
    "POST /repositories/example-ws/docs/pullrequests/7/comments",
    "POST /repositories/example-ws/docs/pullrequests/7/comments",
    "PUT /repositories/example-ws/docs/pullrequests/7/comments/41",
    "POST /repositories/example-ws/docs/pullrequests/7/comments/42/resolve",
    "PUT /repositories/example-ws/docs/pullrequests/7",
    "PUT /repositories/example-ws/docs/pullrequests/7",
  ]);
  assert.deepEqual(writes[1].body, { content: { raw: "Inline" }, inline: { path: "a.go", to: 3 } });
  assert.deepEqual(writes[5].body, { draft: false });
  const ada = "Basic " + Buffer.from("ada@example.com:ada-secret-token").toString("base64");
  assert.ok(f.calls.every((c) => c.auth === ada && c.redirect === "error"));

  const receipt = JSON.parse(await readFile(path.join(f.gitDir, RECEIPTS_DIR, receiptName("review-0001-abcdef")), "utf8"));
  assert.equal(receipt.completed, true);
  assert.deepEqual(receipt.results.slice(0, 2).map((r) => r.comment), [500, 501]);
  assert.ok(!JSON.stringify(receipt).includes("secret-token"));

  // The same intent is never carried out twice.
  const again = await f.writer.ask(action());
  assert.equal(again.ok, false);
  assert.match(again.error, /carried out already/);
});

test("only the person who asked confirms, and only what they were shown", async () => {
  const f = await fixture();
  await f.ask(request([{ op: "comment.create", text: "Summary" }]));
  const asked = await f.writer.ask(action());
  f.setProfile("bob");
  let r = await f.writer.confirm(action({ requestId: asked.result.requestId, requestDigest: asked.result.confirmation.requestDigest }));
  assert.match(r.error, /only the person who asked/);
  f.setProfile("ada");
  r = await f.writer.confirm(action({ requestId: asked.result.requestId, requestDigest: "0".repeat(64) }));
  assert.match(r.error, /does not match/);
  // The agent changes the request after the person saw it.
  const fresh = await f.writer.ask(action());
  await f.ask(request([{ op: "comment.create", text: "Something else" }]));
  r = await f.writer.confirm(action({ requestId: fresh.result.requestId, requestDigest: fresh.result.confirmation.requestDigest }));
  assert.match(r.error, /changed since you asked/);
  assert.ok(!f.calls.some((c) => c.method !== "GET"));
  f.setProfile(undefined);
  r = await f.writer.ask(action());
  assert.match(r.error, /sign in as a person/);
});

test("the repository, pull request and head are pinned", async () => {
  let f = await fixture();
  await f.ask(request([{ op: "comment.create", text: "x" }], { owner: "other-ws", repo: "docs" }));
  assert.match((await f.writer.ask(action())).error, /another repository/);

  f = await fixture({ pr: { source: { commit: { hash: "ffffffffffff" } } } });
  await f.ask(request([{ op: "comment.create", text: "x" }]));
  assert.match((await f.writer.ask(action())).error, /moved on/);

  f = await fixture({ pr: { destination: { repository: { full_name: "other-ws/docs" } } } });
  await f.ask(request([{ op: "comment.create", text: "x" }]));
  assert.match((await f.writer.ask(action())).error, /another pull request/);

  f = await fixture({ pr: { draft: false } });
  await f.ask(request([{ op: "pr.ready" }]));
  assert.match((await f.writer.ask(action())).error, /not a draft/);

  f = await fixture({ comments: { 41: { user: { uuid: "{bob}" } } } });
  await f.ask(request([{ op: "comment.update", comment: 41, text: "x" }]));
  assert.match((await f.writer.ask(action())).error, /not yours to edit/);

  f = await fixture({ comments: { 42: { pullrequest: { id: 8 } } } });
  await f.ask(request([{ op: "comment.resolve", comment: 42 }]));
  assert.match((await f.writer.ask(action())).error, /not on pull request #7/);
});

test("a failure stops the run; an unanswered write is unknown, never retried", async () => {
  for (const [options, status] of [
    [{ failOn: { method: "PUT", suffix: "/comments/41", status: 403 } }, "failed"],
    [{ failOn: { method: "PUT", suffix: "/comments/41", status: 502 } }, "unknown"],
    [{ nonJsonOn: { method: "PUT", suffix: "/comments/41" } }, "unknown"],
    [{ hangOn: { method: "PUT", suffix: "/comments/41" } }, "unknown"],
  ]) {
    const f = await fixture(options);
    await f.ask(request([
      { op: "comment.create", text: "first" },
      { op: "comment.update", comment: 41, text: "second" },
      { op: "comment.resolve", comment: 42 },
    ]));
    const asked = await f.writer.ask(action());
    const done = await f.writer.confirm(action({ requestId: asked.result.requestId, requestDigest: asked.result.confirmation.requestDigest }));
    assert.equal(done.result.status, "stopped");
    assert.deepEqual(done.result.receipt.results.map((r) => r.status), ["done", status, "skipped"]);
    assert.equal(f.calls.filter((c) => c.method === "PUT").length, 1, "never retried");
    assert.ok(!f.calls.some((c) => c.route.endsWith("/resolve")));
  }
});

test("requests outside the closed shape are refused", () => {
  const base = { version: 1, intentId: "review-0001-abcdef", pr: 7, head: HEAD };
  for (const [operations, message] of [
    [[{ op: "exec", command: "rm -rf /" }], /not a supported/],
    [[{ op: "comment.create", text: "x", token: "t" }], /unsupported field/],
    [[{ op: "comment.create", text: "" }], /non-empty/],
    [[{ op: "comment.create", text: "x", inline: { path: "a", to: 1, from: 2 } }], /exactly one line/],
    [[{ op: "pr.update" }], /changes nothing/],
    [[{ op: "pr.update", title: "a\nb" }], /one line/],
    [[], /1-100 operations/],
  ]) {
    assert.throws(() => parseRequest(JSON.stringify({ ...base, operations })), message);
  }
  assert.throws(() => parseRequest(JSON.stringify({ ...base, intentId: "../x", operations: [{ op: "pr.ready" }] })), /intentId/);
  assert.throws(() => parseRequest(JSON.stringify({ ...base, url: "https://elsewhere", operations: [{ op: "pr.ready" }] })), /unsupported field/);
});

test("two confirms of one intent close together write once", async () => {
  const f = await fixture();
  await f.ask(request([{ op: "comment.create", text: "Summary" }]));
  const first = await f.writer.ask(action());
  const second = await f.writer.ask(action());
  const results = await Promise.all([first, second].map((a) => f.writer.confirm(action({ requestId: a.result.requestId, requestDigest: a.result.confirmation.requestDigest }))));
  assert.equal(results.filter((r) => r.ok).length, 1, JSON.stringify(results));
  assert.equal(f.calls.filter((c) => c.method === "POST").length, 1);
});

test("a write whose answer cannot be read is unknown, and an interrupted intent is not run again", async () => {
  const f = await fixture({ unreadableOn: { method: "POST", suffix: "/comments" } });
  await f.ask(request([{ op: "comment.create", text: "Summary" }, { op: "pr.ready" }]));
  const asked = await f.writer.ask(action());
  const done = await f.writer.confirm(action({ requestId: asked.result.requestId, requestDigest: asked.result.confirmation.requestDigest }));
  assert.deepEqual(done.result.receipt.results.map((r) => r.status), ["unknown", "skipped"]);
  // A claim without a receipt (a run that died before writing it) refuses a repeat.
  const g = await fixture();
  await g.ask(request([{ op: "comment.create", text: "Summary" }]));
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(path.join(g.gitDir, RECEIPTS_DIR), { recursive: true });
  await writeFile(path.join(g.gitDir, RECEIPTS_DIR, claimName("review-0001-abcdef")), "2026-11-23T00:00:00Z\n");
  const again = await g.writer.ask(action());
  assert.equal(again.ok, false);
  assert.match(again.error, /carried out already/);
  assert.ok(!g.calls.some((c) => c.method !== "GET"));
});
