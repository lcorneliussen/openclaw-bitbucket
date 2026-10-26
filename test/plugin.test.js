import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Readable } from "node:stream";

import { loginFile, loginsDir, readLogin, writeLogin } from "../lib/logins.js";
import { BitbucketRejected, verifyToken } from "../lib/bitbucket.js";

const run = promisify(execFile);
const scripts = fileURLToPath(new URL("../skills/bitbucket/scripts/", import.meta.url));
const stateDir = () => mkdtemp(path.join(tmpdir(), "bitbucket-plugin-"));
const login = (profile, user = "ada@example.com") => ({
  profile,
  user,
  name: "Ada Example",
  token: "token-of-" + profile,
  stored: "2026-01-02T03:04:05.000Z",
});

// index.js imports the OpenClaw SDK, which only exists inside a gateway.
// The logic under test is exported from it, so load it with the SDK stubbed.
async function loadIndex() {
  const { register } = await import("node:module");
  register(
    "data:text/javascript," +
      encodeURIComponent(`
        export async function resolve(specifier, context, next) {
          if (specifier.startsWith("openclaw/plugin-sdk/")) {
            return { url: "data:text/javascript,export const definePluginEntry=(e)=>e;export const getPluginRuntimeGatewayRequestScope=()=>undefined;", shortCircuit: true };
          }
          return next(specifier, context);
        }`),
  );
  return import("../index.js");
}
const index = await loadIndex();

test("a login is stored for its owner only, in a private file", async () => {
  const dir = await stateDir();
  const file = await writeLogin(dir, login("profile-a"));
  assert.equal(file, loginFile(dir, "profile-a"));
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(loginsDir(dir))).mode & 0o777, 0o700);
  assert.equal((await readLogin(dir, "profile-a")).token, "token-of-profile-a");
  assert.equal(await readLogin(dir, "profile-b"), undefined);
  assert.ok(!path.basename(file).includes("profile-a"));
});

test("a login with a line break is refused", async () => {
  const dir = await stateDir();
  await assert.rejects(writeLogin(dir, { ...login("p"), token: "a\nuser=evil" }));
});

test("the session owner is the assigned human, else the signed-in creator, else the parent's", async () => {
  const entries = {
    assigned: { owner: { actor: { type: "human", id: "p-owner" } }, createdActor: { type: "human", id: "p-creator", source: "profile" } },
    created: { createdActor: { type: "human", id: "p-creator", source: "profile" } },
    channel: { createdActor: { type: "human", id: "chat-user", source: "channel" } },
    child: { createdActor: { type: "agent", id: "main" }, parentSessionKey: "created" },
    agentOwned: { owner: { actor: { type: "agent", id: "main" } }, createdActor: { type: "human", id: "p-creator", source: "profile" } },
    orphan: { createdActor: { type: "system" } },
  };
  const get = async ({ sessionKey }) => entries[sessionKey];
  const owner = (key) => index.sessionOwnerProfileId(get, key);
  assert.equal(await owner("assigned"), "p-owner");
  assert.equal(await owner("created"), "p-creator");
  assert.equal(await owner("channel"), undefined);
  assert.equal(await owner("child"), "p-creator");
  assert.equal(await owner("agentOwned"), "p-creator");
  assert.equal(await owner("orphan"), undefined);
  assert.equal(await owner("missing"), undefined);
});

test("exec gets the owner's login, and an empty answer when there is none", async () => {
  const dir = await stateDir();
  await writeLogin(dir, login("p-creator"));
  const deps = {
    stateDir: dir,
    gitIdentity: true,
    getSessionEntry: async ({ sessionKey }) =>
      ({ mine: { createdActor: { type: "human", id: "p-creator", source: "profile" } },
         theirs: { createdActor: { type: "human", id: "p-other", source: "profile" } } })[sessionKey],
  };
  const mine = await index.execEnv(deps, { sessionKey: "mine", host: "gateway" }, {});
  assert.equal(mine.BITBUCKET_LOGIN_FILE, loginFile(dir, "p-creator"));
  assert.equal(mine.GIT_AUTHOR_EMAIL, "ada@example.com");
  assert.equal(mine.GIT_COMMITTER_NAME, "Ada Example");
  assert.ok(!Object.values(mine).some((value) => value.includes("token-of-")), "no token in the environment");

  for (const event of [{ sessionKey: "theirs", host: "gateway" }, { sessionKey: "mine", host: "sandbox" }, { host: "gateway" }]) {
    const env = await index.execEnv(deps, event, {});
    assert.equal(env.BITBUCKET_LOGIN_FILE, "");
    assert.equal(env.GIT_AUTHOR_EMAIL, undefined);
  }

  // With execLogin off, commands commit as the owner but get no login.
  const gated = await index.execEnv({ ...deps, execLogin: false }, { sessionKey: "mine", host: "gateway" }, {});
  assert.equal(gated.BITBUCKET_LOGIN_FILE, "");
  assert.equal(gated.BITBUCKET_PUBLISH, "gateway");
  assert.equal(gated.GIT_AUTHOR_EMAIL, "ada@example.com");
});

function response() {
  const res = { statusCode: 0, headers: {}, body: "" };
  res.setHeader = (name, value) => { res.headers[name] = value; };
  res.end = (body = "") => { res.body = body; };
  return res;
}
const request = (method, form) =>
  Object.assign(Readable.from(form ? [Buffer.from(new URLSearchParams(form).toString())] : []), { method });
const ticketOf = (html) => /name="ticket" value="([^"]+)"/.exec(html)[1];

test("connect pages preserve the same-origin form Origin, including when retrying an error", async () => {
  const handler = index.createConnectHandler({
    stateDir: await stateDir(),
    currentProfile: () => ({ profileId: "p-ada", displayName: "Ada" }),
    verify: async () => { throw new BitbucketRejected("Token rejected."); },
  });
  for (const method of ["GET", "HEAD", "POST"]) {
    const res = response();
    await handler(request(method, method === "POST" ? { ticket: "expired" } : undefined), res);
    assert.equal(res.statusCode, method === "POST" ? 400 : 200);
    assert.equal(res.headers["referrer-policy"], "same-origin");
    // The document policy also survives a gateway's no-referrer header.
    assert.match(res.body, /<head>[\s\S]*<meta name="referrer" content="same-origin">[\s\S]*<\/head>/);

    if (method === "POST") {
      const retry = response();
      await handler(request("POST", { ticket: ticketOf(res.body), action: "connect", user: "ada@example.com", token: "invalid-test-token" }), retry);
      assert.equal(retry.statusCode, 400);
      assert.match(retry.body, /Token rejected/);
      assert.equal(retry.headers["referrer-policy"], "same-origin");
      assert.match(retry.body, /<meta name="referrer" content="same-origin">/);
    }
  }
});

test("the page stores a login for the signed-in person only", async () => {
  const dir = await stateDir();
  let profile = { profileId: "p-ada", displayName: "Ada" };
  const calls = [];
  const handler = index.createConnectHandler({
    stateDir: dir,
    currentProfile: () => profile,
    verify: async (user, token) => {
      calls.push([user, token]);
      if (token === "wrong") throw new BitbucketRejected("Bitbucket did not accept this e-mail and token.");
      return "Ada Example";
    },
  });

  let res = response();
  await handler(request("GET"), res);
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /Not connected/);
  const ticket = ticketOf(res.body);

  // Someone else cannot use Ada's form.
  profile = { profileId: "p-eve", displayName: "Eve" };
  res = response();
  await handler(request("POST", { ticket, action: "connect", user: "eve@example.com", token: "t" }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(await readLogin(dir, "p-eve"), undefined);
  assert.equal(calls.length, 0);

  profile = { profileId: "p-ada", displayName: "Ada" };
  res = response();
  await handler(request("GET"), res);
  res = response();
  await handler(request("POST", { ticket: ticketOf((await (async () => { const r = response(); await handler(request("GET"), r); return r; })()).body), action: "connect", user: "ada@example.com", token: "wrong" }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(await readLogin(dir, "p-ada"), undefined);

  const good = ticketOf(res.body);
  res = response();
  await handler(request("POST", { ticket: good, action: "connect", user: "ada@example.com", token: "s3cret" }), res);
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /Connected as/);
  assert.ok(!res.body.includes("s3cret"), "the page never shows the token");
  assert.equal((await readLogin(dir, "p-ada")).token, "s3cret");

  // A ticket works once.
  const again = response();
  await handler(request("POST", { ticket: good, action: "disconnect" }), again);
  assert.equal(again.statusCode, 400);
  assert.ok(await readLogin(dir, "p-ada"));

  res = response();
  await handler(request("POST", { ticket: ticketOf(again.body), action: "disconnect" }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(await readLogin(dir, "p-ada"), undefined);
});

test("without an identified person nothing is stored", async () => {
  const dir = await stateDir();
  const handler = index.createConnectHandler({ stateDir: dir, currentProfile: () => undefined, verify: async () => "x" });
  let res = response();
  await handler(request("GET"), res);
  assert.match(res.body, /does not know who you are/);
  res = response();
  await handler(request("POST", { ticket: "", action: "connect", user: "a@b.c", token: "t" }), res);
  assert.equal(res.statusCode, 403);
});

test("verifyToken tells a rejected token from an unreachable Bitbucket", async () => {
  const ok = async (url, init) => {
    assert.equal(init.headers.authorization, "Basic " + Buffer.from("a@b.c:t").toString("base64"));
    return { status: 200, ok: true, json: async () => ({ display_name: "Ada" }) };
  };
  assert.equal(await verifyToken("a@b.c", "t", ok), "Ada");
  await assert.rejects(verifyToken("a@b.c", "t", async () => ({ status: 401, ok: false })), BitbucketRejected);
  await assert.rejects(verifyToken("a@b.c", "t", async () => { throw new Error("offline"); }), (e) => !(e instanceof BitbucketRejected));
});

test("the git credential helper answers for bitbucket.org from the login file only", async () => {
  const dir = await stateDir();
  const file = await writeLogin(dir, login("p"));
  const helper = path.join(scripts, "git-credential-bitbucket");
  const ask = async (env, host) => {
    const child = run(helper, ["get"], { env: { PATH: process.env.PATH, ...env } });
    child.child.stdin.end(`protocol=https\nhost=${host}\n\n`);
    return (await child).stdout;
  };
  assert.equal(await ask({ BITBUCKET_LOGIN_FILE: file }, "bitbucket.org"), "username=x-bitbucket-api-token-auth\npassword=token-of-p\n");
  assert.equal(await ask({ BITBUCKET_LOGIN_FILE: file }, "github.com"), "");
  assert.equal(await ask({ BITBUCKET_LOGIN_FILE: "" }, "bitbucket.org"), "");
  assert.equal(await ask({}, "bitbucket.org"), "");
});

test("bb refuses when the owner has not connected, and never prints the token", async () => {
  const bb = path.join(scripts, "bb");
  await assert.rejects(run(bb, ["repo", "get"], { env: { PATH: process.env.PATH, BITBUCKET_LOGIN_FILE: "" } }), (error) => {
    assert.equal(error.code, 3);
    assert.match(error.stderr, /has not connected Bitbucket/);
    return true;
  });
  assert.ok(!(await readFile(bb, "utf8")).includes("echo \"$TWG_BBC_TOKEN"));
});

test("the publish actions are registered, and need a signed-in person", async () => {
  const actions = new Map();
  const api = {
    pluginConfig: {},
    logger: {},
    runtime: { state: { resolveStateDir: () => "/nonexistent" }, agent: { session: { getSessionEntry: async () => undefined } } },
    on() {},
    registerHttpRoute() {},
    session: { controls: { registerSessionAction: (a) => actions.set(a.id, a), registerControlUiDescriptor() {} } },
  };
  index.default.register(api);
  assert.deepEqual(["publish-options", "publish", "publish-confirm"].map((id) => actions.get(id)?.requiredScopes?.[0]), ["operator.read", "operator.write", "operator.write"]);
  assert.deepEqual(actions.get("publish-confirm").schema.required, ["requestId", "requestDigest"]);
  // The stubbed SDK has no request scope, so there is no person to publish as.
  for (const id of ["publish-options", "publish", "publish-confirm"]) {
    const res = await actions.get(id).handler({ sessionKey: "s", agentId: "main", payload: { requestId: "r", requestDigest: "d" } });
    assert.equal(res.ok, false);
    assert.match(res.error, /sign in as a person/);
  }
});
