// skills/bitbucket/scripts/publish-intent.mjs against a local bare repository
// standing in for Bitbucket. Pull requests go to a fake `twg`, or to a local
// HTTP server where the script asks Bitbucket directly. No network, no login.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../skills/bitbucket/scripts/publish-intent.mjs", import.meta.url));
const branch = "openclaw/72-add-thing";
const identity = { GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com" };

const fakeTwg = `#!/bin/sh
echo "$*" >> "$TWG_STATE/calls"
case "$*" in
  *"prs query"*) if [ -f "$TWG_STATE/open" ]; then cat "$TWG_STATE/open"; else echo '{"ok":true,"data":{"values":[]}}'; fi ;;
  *"prs create"*)
    echo '{"ok":true,"data":{"id":7,"title":"x","links":{"html":{"href":"https://bitbucket.org/example-ws/docs/pull-requests/7"}}}}' | tee "$TWG_STATE/open" ;;
esac
`;

// A checkout as a gateway hands it to a session: origin names Bitbucket,
// pushes land in a local bare repository, the work is committed on a branch.
function fixture({ twg = true } = {}) {
  const work = mkdtempSync(path.join(tmpdir(), "publish-intent-"));
  const origin = path.join(work, "origin.git"), docs = path.join(work, "docs"), state = path.join(work, "state");
  mkdirSync(path.join(work, "bin"));
  mkdirSync(state);
  if (twg) {
    writeFileSync(path.join(work, "bin", "twg"), fakeTwg);
    chmodSync(path.join(work, "bin", "twg"), 0o755);
  }
  // Only this fixture's bin and the system's: a twg installed on the
  // machine must not answer for the fake one, or stand in where none is meant.
  const env = { ...identity, HOME: work, TWG_STATE: state, GIT_CONFIG_GLOBAL: "/dev/null",
    PATH: [path.join(work, "bin"), path.dirname(process.execPath), "/usr/bin", "/bin"].join(":") };
  const git = (...args) => execFileSync("git", ["-C", docs, ...args], { env, encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], { env });
  execFileSync("git", ["clone", "-q", origin, docs], { env, stdio: "ignore" });
  writeFileSync(path.join(docs, "README.md"), "docs\n");
  git("add", "."); git("commit", "-qm", "init"); git("push", "-q", "origin", "HEAD:main");
  git("remote", "set-url", "origin", "git@bitbucket.org:example-ws/docs.git");
  git("remote", "set-url", "--push", "origin", origin);
  git("switch", "-qc", branch);
  writeFileSync(path.join(docs, "notes.md"), "one\n");
  git("add", "."); git("commit", "-qm", "Add notes");
  const remoteHead = () => execFileSync("git", ["-C", origin, "rev-parse", "--verify", "--quiet", branch], { env, encoding: "utf8" }).trim();
  const calls = () => (existsSync(path.join(state, "calls")) ? readFileSync(path.join(state, "calls"), "utf8") : "");
  return { work, docs, env, git, remoteHead, calls };
}

function plan({ source = branch, tool } = {}) {
  const intent = { host: "openclaw", version: 1, action: "publish", actor: "repo-session", repo: "docs", forge: "bitbucket",
    ...(tool ? { tool } : {}),
    args: { owner: "example-ws", repo: "docs", source, dest: "main", title: "Add notes", body: "Why.", draft: true } };
  // What reaches the script is a command's whole output: the plan and then some.
  return JSON.stringify({ host: "openclaw", version: 1, intents: [intent] }, null, 2) + "\nwtc: nothing was done.\n";
}

function publish(f, input, args = [], extraEnv = {}) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [script, ...args], { cwd: f.docs, env: { ...f.env, ...extraEnv }, encoding: "utf8" },
      (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr, json: error ? null : JSON.parse(stdout) }));
    child.stdin.end(input);
  });
}

test("a dry run checks and changes nothing", async () => {
  const f = fixture();
  const r = await publish(f, plan(), ["--dry-run"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.status, "dry-run");
  assert.equal(f.calls(), "");
  assert.throws(() => f.remoteHead());
});

test("it pushes the branch and opens a draft pull request, then reuses it", async () => {
  const f = fixture();
  const first = await publish(f, plan());
  assert.equal(first.code, 0, first.stderr);
  assert.deepEqual(first.json, { status: "published", url: "https://bitbucket.org/example-ws/docs/pull-requests/7", number: 7, branch, dest: "main", created: true });
  assert.equal(f.remoteHead(), f.git("rev-parse", "HEAD"));
  assert.match(f.calls(), /prs create --title Add notes --source openclaw\/72-add-thing --dest main --draft --description-file \S+ --workspace example-ws --repo docs -o json/);

  writeFileSync(path.join(f.docs, "notes.md"), "one\ntwo\n");
  f.git("commit", "-qam", "More notes");
  const second = await publish(f, plan());
  assert.equal(second.code, 0, second.stderr);
  assert.equal(second.json.created, false);
  assert.equal(second.json.number, 7);
  assert.equal(f.remoteHead(), f.git("rev-parse", "HEAD"));
  assert.equal(f.calls().match(/prs create/g).length, 1);
});

test("rewritten history is refused and nothing is forced", async () => {
  const f = fixture();
  await publish(f, plan());
  const published = f.remoteHead();
  f.git("commit", "-q", "--amend", "-m", "Rewritten");
  const r = await publish(f, plan());
  assert.equal(r.code, 1);
  assert.match(r.stderr, /do not rebase, do not force/);
  assert.equal(f.remoteHead(), published);
});

test("it refuses what it would have to repair", async (t) => {
  await t.test("uncommitted work", async () => {
    const f = fixture();
    writeFileSync(path.join(f.docs, "stray.txt"), "stray\n");
    const r = await publish(f, plan());
    assert.equal(r.code, 1);
    assert.match(r.stderr, /uncommitted work/);
  });
  await t.test("another branch", async () => {
    const f = fixture();
    const r = await publish(f, plan({ source: "openclaw/other" }));
    assert.equal(r.code, 1);
    assert.match(r.stderr, /do not switch branches/);
  });
  await t.test("an intent that names a tool", async () => {
    const f = fixture();
    const r = await publish(f, plan({ tool: "github_publish" }));
    assert.equal(r.code, 1);
    assert.match(r.stderr, /github_publish/);
  });
  await t.test("a checkout of another repository", async () => {
    const f = fixture();
    f.git("remote", "set-url", "origin", "https://github.com/example-org/docs.git");
    const r = await publish(f, plan());
    assert.equal(r.code, 1);
    assert.match(r.stderr, /intent is for bitbucket example-ws docs/);
  });
});

test("without twg it asks Bitbucket directly, with the session owner's login", async () => {
  const f = fixture({ twg: false });
  const seen = [];
  let open = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c)).on("end", () => {
      seen.push({ method: req.method, url: decodeURIComponent(req.url), auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
      res.setHeader("content-type", "application/json");
      if (req.method === "POST") {
        open = [{ id: 9, title: "Add notes", links: { html: { href: "https://bitbucket.org/example-ws/docs/pull-requests/9" } } }];
        res.statusCode = 201;
        res.end(JSON.stringify(open[0]));
      } else res.end(JSON.stringify({ values: open }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const loginFile = path.join(f.work, "ada.login");
    writeFileSync(loginFile, "profile=p\nuser=ada@example.com\nname=Ada\ntoken=secret-token\nstored=2026-01-02T03:04:05.000Z\n", { mode: 0o600 });
    const env = { BITBUCKET_API_URL: `http://127.0.0.1:${server.address().port}`, BITBUCKET_LOGIN_FILE: loginFile };

    const first = await publish(f, plan(), [], env);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(first.json.created, true);
    assert.equal(first.json.url, "https://bitbucket.org/example-ws/docs/pull-requests/9");
    assert.equal(f.remoteHead(), f.git("rev-parse", "HEAD"));
    assert.equal(seen[0].url, `/repositories/example-ws/docs/pullrequests?q=source.branch.name="${branch}" AND destination.branch.name="main" AND state="OPEN"`);
    assert.equal(seen[0].auth, "Basic " + Buffer.from("ada@example.com:secret-token").toString("base64"));
    assert.deepEqual(seen[1].body, { title: "Add notes", description: "Why.", draft: true, source: { branch: { name: branch } }, destination: { branch: { name: "main" } } });
    assert.doesNotMatch(first.stdout + first.stderr, /secret-token/);

    const second = await publish(f, plan(), [], env);
    assert.equal(second.json.created, false);
    assert.equal(seen.filter((s) => s.method === "POST").length, 1);

    const nobody = await publish(f, plan(), [], { ...env, BITBUCKET_LOGIN_FILE: "", BITBUCKET_CONNECT_PATH: "/plugins/bitbucket/connect" });
    assert.equal(nobody.code, 1);
    assert.match(nobody.stderr, /has not connected Bitbucket.*\/plugins\/bitbucket\/connect/);
  } finally {
    server.close();
  }
});
