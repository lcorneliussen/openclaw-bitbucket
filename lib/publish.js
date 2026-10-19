// Publishing a session's worktree to Bitbucket from the gateway, as the
// person who asks and only once they confirm.
//
// The counterpart of OpenClaw's own sessions.github.publish for a personal
// GitHub connection: the token stays in the gateway, the agent is not
// involved, and the confirmation names the exact commit, branch and account.
//
//   options  what would be published, and with whose login
//   publish  → needs_confirmation {requestId, confirmation: {account, requestDigest, …}}
//   confirm  {requestId, requestDigest} → published {url, number, created}
//
// It pushes the branch the worktree is on, as it is: no commit is made, no
// branch is rewritten, nothing is forced. Uncommitted files stay behind and
// the confirmation says how many.
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { readLogin } from "./logins.js";

const execFileAsync = promisify(execFile);
const REQUEST_TTL_MS = 10 * 60_000;
const API = "https://api.bitbucket.org/2.0";
const NAME = /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/;
// The token reaches git through its environment, never a URL or a config file.
const HELPER = "!f() { [ \"$1\" = get ] && printf 'username=x-bitbucket-api-token-auth\\npassword=%s\\n' \"$BITBUCKET_PUBLISH_TOKEN\"; }; f";

export class PublishRefused extends Error {}

// bitbucket.org/<workspace>/<repo> from an https or ssh remote.
export function parseBitbucketRemote(url) {
  const m = String(url ?? "").trim().match(/^(?:https:\/\/(?:[^@/]+@)?bitbucket\.org\/|git@bitbucket\.org:|ssh:\/\/git@bitbucket\.org\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  return m ? { owner: m[1], repo: m[2] } : undefined;
}

// A managed worktree, as the gateway records it on the session.
const worktreeOf = (entry) => (entry?.worktree ? entry.workspaceDir || entry.spawnedCwd || entry.worktree.path || null : null);

export function digestOf(request) {
  const fields = ["sessionKey", "owner", "repo", "branch", "head", "dest", "title", "draft", "account"];
  return createHash("sha256").update(JSON.stringify(fields.map((f) => request[f] ?? null))).digest("hex");
}

export function createPublisher({ stateDir, getSessionEntry, currentProfile, fetchImpl = fetch, gitEnv = {}, apiUrl = API, now = Date.now }) {
  const requests = new Map();

  const git = async (cwd, args, env = {}) => {
    try {
      const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
        env: { ...process.env, ...gitEnv, ...env, GIT_TERMINAL_PROMPT: "0" },
        timeout: 120_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      return stdout.trim();
    } catch (error) {
      const err = new Error(String(error.stderr || error.message).trim());
      err.stderr = String(error.stderr ?? "");
      throw err;
    }
  };

  // The person asking, and their own login. Nobody else's is ever used.
  async function requester() {
    const profileId = currentProfile()?.profileId;
    if (!profileId) throw new PublishRefused("sign in as a person: publishing uses your own Bitbucket login, and this connection has none");
    const login = await readLogin(stateDir, profileId);
    return { profileId, login };
  }

  async function bitbucket(login, method, path, payload) {
    const res = await fetchImpl(`${apiUrl}${path}`, {
      method,
      headers: {
        authorization: "Basic " + Buffer.from(`${login.user}:${login.token}`).toString("base64"),
        accept: "application/json",
        ...(payload ? { "content-type": "application/json" } : {}),
      },
      body: payload ? JSON.stringify(payload) : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) throw new PublishRefused(`Bitbucket answered ${res.status} to ${method} ${path.split("?")[0]}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  }

  // What the worktree of a session would publish, read now.
  async function inspect({ sessionKey, agentId }, payload = {}) {
    if (!sessionKey) throw new PublishRefused("name the session whose worktree to publish");
    const entry = await getSessionEntry({ sessionKey, ...(agentId ? { agentId } : {}) });
    const cwd = worktreeOf(entry);
    if (!cwd) throw new PublishRefused("this session owns no managed worktree");
    const remote = parseBitbucketRemote(await git(cwd, ["config", "--get", "remote.origin.url"]).catch(() => ""));
    if (!remote) throw new PublishRefused("this worktree's origin is not a Bitbucket repository");
    const branch = await git(cwd, ["branch", "--show-current"]);
    if (!branch) throw new PublishRefused("the worktree is not on a branch");
    if (!NAME.test(branch)) throw new PublishRefused(`the branch name ${branch} cannot be published`);
    if (await git(cwd, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).catch(() => "")) {
      throw new PublishRefused("a merge is in progress in the worktree: finish it first");
    }
    const head = await git(cwd, ["rev-parse", "HEAD"]);
    let dest = String(payload.dest ?? "");
    if (dest && !NAME.test(dest)) throw new PublishRefused("the destination is not a branch name");
    if (!dest) {
      const ref = await git(cwd, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]).catch(() => "");
      dest = ref.replace(/^origin\//, "") || "main";
    }
    const uncommitted = (await git(cwd, ["status", "--porcelain"])).split("\n").filter(Boolean).length;
    const title = String(payload.title ?? "").trim() || (await git(cwd, ["log", "-1", "--format=%s"]));
    return { cwd, ...remote, branch, head, dest, title, uncommitted, draft: payload.draft !== false };
  }

  async function options(action) {
    const { login } = await requester();
    const target = await inspect(action, action.payload);
    return {
      account: login ? { user: login.user, name: login.name } : null,
      repo: { owner: target.owner, repo: target.repo, branch: target.branch, dest: target.dest, head: target.head, uncommitted: target.uncommitted },
    };
  }

  async function publish(action) {
    const { profileId, login } = await requester();
    if (!login) return { status: "not_connected" };
    const target = await inspect(action, action.payload);
    for (const [id, r] of requests) if (r.expires <= now()) requests.delete(id);
    const request = {
      ...target,
      sessionKey: action.sessionKey,
      agentId: action.agentId,
      profileId,
      account: login.user,
      expires: now() + REQUEST_TTL_MS,
    };
    request.requestDigest = digestOf(request);
    const requestId = randomUUID();
    requests.set(requestId, request);
    return {
      status: "needs_confirmation",
      requestId,
      confirmation: {
        account: login.user,
        name: login.name,
        requestDigest: request.requestDigest,
        owner: request.owner,
        repo: request.repo,
        branch: request.branch,
        head: request.head,
        dest: request.dest,
        title: request.title,
        draft: request.draft,
        uncommitted: request.uncommitted,
      },
    };
  }

  async function confirm(action) {
    const { profileId, login } = await requester();
    const requestId = String(action.payload?.requestId ?? "");
    const request = requests.get(requestId);
    if (!request || request.expires <= now()) {
      requests.delete(requestId);
      throw new PublishRefused("this publication request has expired: ask again");
    }
    // Only the person who asked confirms, for exactly what they were shown.
    if (request.profileId !== profileId || request.sessionKey !== action.sessionKey) {
      throw new PublishRefused("only the person who asked can confirm this publication");
    }
    if (action.payload?.requestDigest !== request.requestDigest) {
      throw new PublishRefused("the confirmation does not match the request: ask again");
    }
    if (!login || login.user !== request.account) throw new PublishRefused("your Bitbucket login changed since you asked: ask again");
    requests.delete(requestId);

    // The worktree must still be what was confirmed.
    const current = await inspect(request, { dest: request.dest, title: request.title, draft: request.draft });
    if (current.head !== request.head || current.branch !== request.branch) {
      throw new PublishRefused("the worktree moved on since you asked: ask again to publish what is there now");
    }

    // A plain push: when origin has commits this branch lacks, it fails, and
    // that is the answer. Catch up and publish again; nothing is forced.
    try {
      await git(request.cwd, [
        "-c", "credential.https://bitbucket.org.helper=",
        "-c", `credential.https://bitbucket.org.helper=${HELPER}`,
        "push", "origin", `${request.head}:refs/heads/${request.branch}`,
      ], { BITBUCKET_PUBLISH_TOKEN: login.token });
    } catch (error) {
      const moved = /non-fast-forward|fetch first|rejected/.test(error.stderr ?? error.message);
      throw new PublishRefused(moved
        ? `origin/${request.branch} has commits this branch lacks: catch up (merge, never rebase) and publish again`
        : `git push failed: ${String(error.message).split("\n").slice(-2).join(" ")}`);
    }

    const base = `/repositories/${request.owner}/${request.repo}/pullrequests`;
    const q = `source.branch.name="${request.branch}" AND destination.branch.name="${request.dest}" AND state="OPEN"`;
    const open = (await bitbucket(login, "GET", `${base}?q=${encodeURIComponent(q)}`))?.values?.[0];
    const pr = open ?? (await bitbucket(login, "POST", base, {
      title: request.title,
      draft: request.draft,
      source: { branch: { name: request.branch } },
      destination: { branch: { name: request.dest } },
    }));
    return {
      status: "published",
      account: login.user,
      branch: request.branch,
      head: request.head,
      dest: request.dest,
      number: pr?.id ?? null,
      url: pr?.links?.html?.href ?? null,
      created: !open,
    };
  }

  // Session action handlers: a refusal is an answer, not a failure.
  const handle = (fn) => async (action) => {
    try {
      return { ok: true, result: await fn(action) };
    } catch (error) {
      if (error instanceof PublishRefused) return { ok: false, error: error.message, code: "refused" };
      throw error;
    }
  };

  return { options: handle(options), publish: handle(publish), confirm: handle(confirm), requests };
}
