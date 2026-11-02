import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectToken, BitbucketRejected, BitbucketScopesMissing, BitbucketUnavailable } from "../lib/bitbucket.js";
import { REQUIRED_SCOPES, TOKEN_SETTINGS_URL, scopeCheck, parseScopeCheck } from "../lib/scopes.js";
import { renderPage } from "../lib/page.js";

const response = (status, body = { display_name: "Ada Example" }, headers = {}) =>
  async () => new Response(JSON.stringify(body), { status, headers });

test("the authenticated identity read checks reported grants without a test write", async () => {
  let calls = 0;
  const result = await inspectToken("ada@example.com", "test-token", async (url, options) => {
    calls++;
    assert.equal(url, "https://api.bitbucket.org/2.0/user");
    assert.equal(options.method ?? "GET", "GET");
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    return response(200, undefined, { "x-oauth-scopes": REQUIRED_SCOPES.join(", ") })();
  });
  assert.equal(calls, 1);
  assert.equal(result.name, "Ada Example");
  assert.equal(result.scopeCheck.status, "verified");
  assert.deepEqual(result.scopeCheck.granted, REQUIRED_SCOPES);
});

test("write scopes do not satisfy independent API-token read scopes", async () => {
  const grants = REQUIRED_SCOPES.filter(s => s !== "read:repository:bitbucket");
  await assert.rejects(inspectToken("a@b.c", "t", response(200, undefined, { "x-oauth-scopes": grants.join(",") })), e => {
    assert.ok(e instanceof BitbucketScopesMissing);
    assert.match(e.message, /read:repository:bitbucket/);
    assert.doesNotMatch(e.message, /write:repository:bitbucket/);
    return true;
  });
});

test("scope denials explain missing grants rather than rejecting valid credentials", async () => {
  const grants = REQUIRED_SCOPES.filter(s => s !== "read:user:bitbucket");
  for (const key of ["detail", "data"]) {
    const body = { error: { message: "untrusted test-token", [key]: { required: ["read:user:bitbucket"], granted: grants } } };
    await assert.rejects(inspectToken("a@b.c", "test-token", response(403, body)), e => {
      assert.ok(e instanceof BitbucketScopesMissing);
      assert.match(e.message, /read:user:bitbucket/);
      assert.ok(!e.message.includes("test-token"));
      return true;
    });
  }
});

test("missing, malformed, legacy and accepted-scope metadata cannot claim verified grants", async () => {
  for (const headers of [{}, { "x-accepted-oauth-scopes": REQUIRED_SCOPES.join(",") }, { "x-oauth-scopes": "repository:write,pullrequest:write,account,pipeline" }, { "x-oauth-scopes": "<script>" }]) {
    const result = await inspectToken("a@b.c", "t", response(200, undefined, headers));
    assert.equal(result.scopeCheck.status, "unknown");
    assert.equal(result.scopeCheck.granted, undefined);
  }
  assert.equal(parseScopeCheck({ ...scopeCheck(), status: "verified" }), undefined);
});

test("authentication, access denial and provider failures remain distinct and secret-free", async () => {
  await assert.rejects(inspectToken("a@b.c", "t", response(401)), e => e instanceof BitbucketRejected && e.credentialsRejected);
  await assert.rejects(inspectToken("a@b.c", "t", response(403, {})), e => e instanceof BitbucketRejected && !e.credentialsRejected && /denied access/.test(e.message));
  for (const status of [429, 500]) {
    let calls = 0;
    await assert.rejects(inspectToken("a@b.c", "t", async () => { calls++; return response(status)(); }), BitbucketUnavailable);
    assert.equal(calls, 1, "no automatic retries");
  }
  await assert.rejects(inspectToken("a@b.c", "test-token", async () => { throw Error("test-token"); }), e => !e.message.includes("test-token"));
  await assert.rejects(inspectToken("a@b.c", "t", response(200, null)), BitbucketUnavailable);
});

test("the creation guide names exactly the six scopes and separates unknown from verified", () => {
  const login = { name: "Ada", user: "ada@example.com", token: "private-test-token", stored: "2026-01-01" };
  const page = check => renderPage({ nonce: "test", path: "/connect", person: "Ada", ticket: "ticket", login: { ...login, scopeCheck: check } });
  const unknown = page(scopeCheck());
  assert.ok(unknown.includes(`href="${TOKEN_SETTINGS_URL}"`));
  assert.ok(unknown.includes("Check permissions"));
  assert.ok(unknown.includes("Token permissions unverified"));
  assert.ok(!unknown.includes("private-test-token"));
  for (const scope of REQUIRED_SCOPES) assert.ok(unknown.includes(`<code>${scope}</code>`));
  assert.match(page(scopeCheck(REQUIRED_SCOPES)), /Token permissions verified/);
  assert.match(page(undefined), /Token permissions not checked/);
  assert.match(page(scopeCheck([])), /Required token scopes missing/);
});
