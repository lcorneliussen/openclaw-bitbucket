import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createConnectionService } from "../lib/connection.js";
import { readLogin, writeLogin } from "../lib/logins.js";
import { scopeCheck, REQUIRED_SCOPES } from "../lib/scopes.js";

const dir = () => mkdtemp(path.join(tmpdir(), "bitbucket-account-"));
const profile = { profileId: "profile-a", displayName: "Ada" };
const form = (action, more = {}) => new URLSearchParams({ action, ...more });
const saved = {
  profile: profile.profileId,
  user: "ada@example.invalid",
  name: "Ada",
  token: "private-synthetic-secret",
  stored: "2026-01-01T00:00:00.000Z",
};

test("native connection uses the authenticated profile and returns metadata without credentials", async () => {
  const stateDir = await dir();
  let observed;
  const service = createConnectionService({
    stateDir,
    verify: async (user, token) => {
      observed = { user, token };
      return { name: "Ada", scopeCheck: scopeCheck(REQUIRED_SCOPES) };
    },
  });
  const out = await service.run(
    profile,
    form("connect", { user: saved.user, token: saved.token }),
  );
  assert.deepEqual(observed, { user: saved.user, token: saved.token });
  assert.equal(out.status, 200);
  assert.equal(out.login.name, "Ada");
  assert.equal(out.login.scopeCheck.status, "verified");
  assert.doesNotMatch(
    JSON.stringify(out),
    /private-synthetic-secret|"token"|"profile"/,
  );
  assert.equal(
    (await readLogin(stateDir, profile.profileId)).token,
    saved.token,
  );
  assert.equal(await readLogin(stateDir, "profile-b"), undefined);
  assert.doesNotMatch(
    JSON.stringify(await service.snapshot(profile)),
    /private-synthetic-secret/,
  );
});

test("a permission check uses only the saved credential, and a missing identity cannot mutate it", async () => {
  const stateDir = await dir();
  await writeLogin(stateDir, saved);
  const seen = [];
  const service = createConnectionService({
    stateDir,
    verify: async (user, token) => {
      seen.push({ user, token });
      return "Ada";
    },
  });
  const checked = await service.run(
    profile,
    form("check", { user: "other@example.invalid", token: "not-used" }),
  );
  assert.equal(checked.status, 200);
  assert.deepEqual(seen, [{ user: saved.user, token: saved.token }]);
  const denied = await service.run(undefined, form("disconnect"));
  assert.equal(denied.status, 403);
  assert.equal(
    (await readLogin(stateDir, profile.profileId)).token,
    saved.token,
  );
});

test("native operations share cancellation and duplicate-operation protection", async () => {
  const stateDir = await dir();
  await writeLogin(stateDir, saved);
  let release, started;
  const waiting = new Promise((r) => {
    started = r;
  });
  const service = createConnectionService({
    stateDir,
    verify: async () => {
      started();
      await new Promise((r) => {
        release = r;
      });
      return "Replacement";
    },
  });
  const first = service.run(
    profile,
    form("connect", { user: saved.user, token: "replacement-synthetic" }),
  );
  await waiting;
  const duplicate = await service.run(profile, form("check"));
  assert.equal(duplicate.status, 409);
  const removed = await service.run(profile, form("disconnect"));
  assert.equal(removed.status, 200);
  release();
  assert.equal((await first).status, 409);
  assert.equal(await readLogin(stateDir, profile.profileId), undefined);
});

test("invalid submitted credentials stop before verification or any credential change", async () => {
  const stateDir = await dir();
  await writeLogin(stateDir, saved);
  let called = false;
  const service = createConnectionService({
    stateDir,
    verify: async () => {
      called = true;
      throw Error("unexpected");
    },
  });
  const out = await service.run(
    profile,
    form("connect", { user: "invalid", token: "synthetic" }),
  );
  assert.equal(out.status, 400);
  assert.equal(called, false);
  assert.equal(
    (await readLogin(stateDir, profile.profileId)).token,
    saved.token,
  );
});
