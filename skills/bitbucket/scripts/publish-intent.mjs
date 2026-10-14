#!/usr/bin/env node
// publish-intent — carry out a publish intent for a Bitbucket repository.
//
//   wtc publish --title "Add thing" | publish-intent.mjs      a plan on stdin
//   publish-intent.mjs intent.json                             or in a file
//   publish-intent.mjs --dry-run < plan.json                   check, change nothing
//
// A tool that cannot publish from where it runs hands the publication over as
// JSON: a plan with intents, or one intent. This takes the one whose action
// is "publish" and whose forge is "bitbucket", pushes its source branch from
// the current checkout and opens a pull request into its destination, or
// finds the one that is already open.
//
// It refuses rather than repair: outside the checkout the intent is for, on
// another branch, with uncommitted work, or when the remote branch has
// commits this one lacks. It never force-pushes.
//
// Login is the skill's (see SKILL.md, Auth) and nothing is added to it: the
// session owner's login file when the gateway has personal logins, otherwise
// what twg and git already have. Pull requests go through `bb` (twg); where
// twg is not installed and a login is at hand, it asks Bitbucket directly.
// Prints one JSON object: {status, url, number, branch, dest, created}.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const file = args.find((a) => !a.startsWith("--"));

function refuse(message) {
  console.error("publish-intent: " + message);
  process.exit(1);
}

function run(cmd, cmdArgs, { allowFail = false } = {}) {
  try {
    return execFileSync(cmd, cmdArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (err) {
    if (allowFail) return null;
    const detail = String(err.stderr || err.stdout || err.message).trim();
    refuse(`${cmd} ${cmdArgs.join(" ")} failed:\n${detail}`);
  }
}

// The first JSON object in text: the plan may be followed by other output.
function firstObject(text) {
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    let depth = 0, inString = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) { if (ch === "\\") i++; else if (ch === '"') inString = false; continue; }
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch { break; }
      }
    }
  }
  return null;
}

const input = firstObject(fs.readFileSync(file ?? 0, "utf8"));
if (!input) refuse("no JSON intent on stdin or in the file given");
const intents = Array.isArray(input.intents) ? input.intents : [input];
const mine = intents.filter((i) => i?.action === "publish" && i?.forge === "bitbucket");
if (mine.length !== 1) {
  const other = intents.find((i) => i?.tool);
  refuse(other
    ? `this intent is for the ${other.tool} tool, not for Bitbucket: call that tool with its args`
    : `expected one publish intent for Bitbucket, found ${mine.length}`);
}
const { owner, repo, source, dest, title, body, draft } = mine[0].args ?? {};
if (mine[0].tool) refuse(`this intent names the ${mine[0].tool} tool: call it instead`);
for (const [name, value] of Object.entries({ owner, repo, source, dest })) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(value)) refuse(`the intent has no usable ${name}`);
}

// The checkout has to be the one the intent was written for.
const forge = run(path.join(here, "git-forge"), [], { allowFail: true });
if (forge !== `bitbucket ${owner} ${repo}`) {
  refuse(`this checkout is "${forge ?? "not a git checkout"}", and the intent is for bitbucket ${owner} ${repo}: run it in the session that owns that repository`);
}
const branch = run("git", ["branch", "--show-current"]);
if (branch !== source) refuse(`this checkout is on ${branch || "a detached HEAD"}, and the intent publishes ${source}: do not switch branches to make it fit`);
const pending = run("git", ["status", "--porcelain"]);
if (pending) refuse(`uncommitted work would stay behind; commit what belongs to the change first:\n${pending}`);

const subject = run("git", ["log", "-1", "--format=%s"]);
const prTitle = title || subject;

if (dryRun) {
  console.log(JSON.stringify({ status: "dry-run", branch: source, dest, title: prTitle, draft: draft === true }, null, 2));
  process.exit(0);
}

// A plain push: it fails when the remote branch has commits this one lacks,
// and that is the answer. Merge them and publish again; never rewrite.
// With a login file, git is pointed at the skill's credential helper for
// this one command, in case the machine has none configured.
const push = ["push", "--set-upstream", "origin", `${source}:refs/heads/${source}`];
if (process.env.BITBUCKET_LOGIN_FILE) {
  push.unshift("-c", "credential.https://bitbucket.org.helper=",
    "-c", `credential.https://bitbucket.org.helper=${path.join(here, "git-credential-bitbucket")}`);
}
try {
  execFileSync("git", push, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
} catch (err) {
  const detail = String(err.stderr || err.message).trim();
  const moved = /non-fast-forward|fetch first|rejected/.test(detail);
  refuse(`git push was rejected${moved ? ": origin has commits this branch lacks. Merge origin/" + source + " (do not rebase, do not force) and publish again" : ""}:\n${detail}`);
}

// Pull requests anywhere in a reply: twg wraps them differently per command.
function pullRequests(value, found = []) {
  if (Array.isArray(value)) value.forEach((v) => pullRequests(v, found));
  else if (value && typeof value === "object") {
    const url = value.links?.html?.href ?? value.url ?? value.html_url;
    if (typeof value.id === "number" && typeof url === "string" && url.includes("/pull-requests/")) found.push({ number: value.id, url, title: value.title });
    else Object.values(value).forEach((v) => pullRequests(v, found));
  }
  return found;
}

// The login for a direct request: the session owner's file, or the variables
// twg itself reads. The token stays in this process.
function login() {
  const file = process.env.BITBUCKET_LOGIN_FILE;
  if (file === undefined) {
    const { TWG_BBC_USER: user, TWG_BBC_TOKEN: token } = process.env;
    return user && token ? { user, token } : null;
  }
  let text = "";
  try { text = file ? fs.readFileSync(file, "utf8") : ""; } catch { /* treated as not connected */ }
  const field = (name) => text.match(new RegExp(`^${name}=(.*)$`, "m"))?.[1];
  if (!field("user") || !field("token")) {
    refuse(`the person this session belongs to has not connected Bitbucket; they open ${process.env.BITBUCKET_CONNECT_PATH || "the Bitbucket page"} on the gateway and connect`);
  }
  return { user: field("user"), token: field("token") };
}

const haveTwg = run("sh", ["-c", "command -v twg"], { allowFail: true }) !== null;
const direct = haveTwg ? null : login();
if (!haveTwg && !direct) refuse("twg is not installed and there is no Bitbucket login to ask Bitbucket with");

const twg = (twgArgs) => JSON.parse(run(path.join(here, "bb"), [...twgArgs, "--workspace", owner, "--repo", repo, "-o", "json"]) || "null");

async function bitbucket(method, query, payload) {
  // BITBUCKET_API_URL exists for this repository's tests.
  const api = process.env.BITBUCKET_API_URL || "https://api.bitbucket.org/2.0";
  const url = `${api}/repositories/${owner}/${repo}/pullrequests${query}`;
  const res = await fetch(url, {
    method,
    headers: { authorization: "Basic " + Buffer.from(`${direct.user}:${direct.token}`).toString("base64"), "content-type": "application/json", accept: "application/json" },
    body: payload ? JSON.stringify(payload) : undefined,
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) refuse(`Bitbucket answered ${res.status} to ${method} pullrequests: ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

async function findOpen() {
  if (!direct) return pullRequests(twg(["prs", "query", "--source", source, "--dest", dest, "--state", "OPEN"]))[0];
  const q = `source.branch.name="${source}" AND destination.branch.name="${dest}" AND state="OPEN"`;
  return pullRequests(await bitbucket("GET", "?q=" + encodeURIComponent(q)))[0];
}

async function create() {
  if (direct) {
    return pullRequests(await bitbucket("POST", "", {
      title: prTitle, description: body || "", draft: draft === true,
      source: { branch: { name: source } }, destination: { branch: { name: dest } },
    }))[0];
  }
  const createArgs = ["prs", "create", "--title", prTitle, "--source", source, "--dest", dest];
  if (draft === true) createArgs.push("--draft");
  let descriptionDir;
  if (body) {
    descriptionDir = fs.mkdtempSync(path.join(os.tmpdir(), "publish-intent-"));
    fs.writeFileSync(path.join(descriptionDir, "description.md"), body.endsWith("\n") ? body : body + "\n");
    createArgs.push("--description-file", path.join(descriptionDir, "description.md"));
  }
  try {
    return pullRequests(twg(createArgs))[0];
  } finally {
    if (descriptionDir) fs.rmSync(descriptionDir, { recursive: true, force: true });
  }
}

let created = false;
let pr = await findOpen();
if (!pr) {
  pr = await create();
  if (!pr) refuse("no pull request came back from Bitbucket; check there before trying again");
  created = true;
}
console.log(JSON.stringify({ status: "published", url: pr.url, number: pr.number, branch: source, dest, created }, null, 2));
