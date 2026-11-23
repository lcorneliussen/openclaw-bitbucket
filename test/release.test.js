import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const read = (file) => readFile(new URL(`../${file}`, import.meta.url), "utf8");

// A release installs from a source tag: the package and the plugin manifest
// carry the same version, and the README's install examples name that tag.
test("package.json, openclaw.plugin.json and the README install examples name one version", async () => {
  const pkg = JSON.parse(await read("package.json"));
  const manifest = JSON.parse(await read("openclaw.plugin.json"));
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.version, pkg.version);
  const installs = [...(await read("README.md")).matchAll(/openclaw plugins install git:github\.com\/lcorneliussen\/openclaw-bitbucket@(v[^\s]+)/g)].map((m) => m[1]);
  assert.ok(installs.length >= 2, "the README shows an install and an upgrade command");
  assert.deepEqual([...new Set(installs)], [`v${pkg.version}`]);
});
