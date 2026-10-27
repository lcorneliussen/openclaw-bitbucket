// Bitbucket for OpenClaw: the skill in skills/, and personal logins.
//
// Each signed-in person stores their own Bitbucket API token on a page the
// gateway serves to them. Before every `exec` the gateway asks this plugin
// for environment; the answer names the login of the person who owns the
// session. The agent neither supplies nor chooses that identity.
import { randomBytes } from "node:crypto";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { getPluginRuntimeGatewayRequestScope } from "openclaw/plugin-sdk/plugin-runtime";
import { BitbucketRejected, verifyToken } from "./lib/bitbucket.js";
import { loginFile, readLogin, removeLogin, writeLogin } from "./lib/logins.js";
import { renderPage } from "./lib/page.js";
import { createPublisher } from "./lib/publish.js";

export const CONNECT_PATH = "/plugins/bitbucket/connect";
const TICKET_TTL_MS = 15 * 60_000;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_PARENTS = 5;

// The person a session belongs to: the assigned human owner, otherwise the
// signed-in person who created it. A session an agent spawned belongs to the
// owner of the session that spawned it.
export async function sessionOwnerProfileId(getSessionEntry, sessionKey, agentId) {
  let key = sessionKey;
  for (let depth = 0; key && depth <= MAX_PARENTS; depth += 1) {
    const entry = await getSessionEntry({ sessionKey: key, ...(agentId ? { agentId } : {}) });
    if (!entry) return undefined;
    const assigned = entry.owner?.actor;
    if (assigned?.type === "human") return assigned.id || undefined;
    const creator = entry.createdActor;
    if (creator?.type === "human") {
      return creator.source === "profile" ? creator.id || undefined : undefined;
    }
    key = entry.parentSessionKey ?? entry.spawnedBy;
  }
  return undefined;
}

// Environment for one exec. BITBUCKET_LOGIN_FILE is always answered, empty
// when the owner has no login: plugin values override what the agent passes,
// so a command cannot point itself at somebody else's file through `env`.
//
// With `execLogin` off, commands get the owner's name for their commits but
// no login: pushing and pull requests then go through the gateway's
// confirmed publish only, and BITBUCKET_PUBLISH says so.
export async function execEnv({ stateDir, getSessionEntry, gitIdentity, execLogin = true }, event, ctx) {
  const env = { BITBUCKET_LOGIN_FILE: "", BITBUCKET_CONNECT_PATH: CONNECT_PATH };
  if (!execLogin) env.BITBUCKET_PUBLISH = "gateway";
  // The login file exists on the gateway's own disk only.
  if (event.host !== "gateway") return env;
  const profileId = await sessionOwnerProfileId(
    getSessionEntry,
    event.sessionKey ?? ctx?.sessionKey,
    ctx?.agentId,
  );
  const login = profileId ? await readLogin(stateDir, profileId) : undefined;
  if (!login) return env;
  if (execLogin) env.BITBUCKET_LOGIN_FILE = loginFile(stateDir, profileId);
  env.BITBUCKET_USER = login.user;
  env.TWG_BBC_USER = login.user;
  if (gitIdentity) {
    env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = login.name;
    env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = login.user;
  }
  return env;
}

async function readForm(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("request too large");
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

// The page and its form. `tickets` ties a form to the person it was rendered
// for, so a request forged from another site cannot store or delete a login.
export function createConnectHandler({ stateDir, currentProfile, verify = verifyToken, log }) {
  const tickets = new Map();

  const issueTicket = (profileId) => {
    const now = Date.now();
    for (const [ticket, entry] of tickets) if (entry.expires <= now) tickets.delete(ticket);
    const ticket = randomBytes(32).toString("base64url");
    tickets.set(ticket, { profileId, expires: now + TICKET_TTL_MS });
    return ticket;
  };

  const redeemTicket = (ticket, profileId) => {
    const entry = tickets.get(ticket);
    tickets.delete(ticket);
    return Boolean(entry && entry.profileId === profileId && entry.expires > Date.now());
  };

  const send = (res, status, html, nonce) => {
    res.statusCode = status;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.setHeader("referrer-policy", "same-origin");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader(
      "content-security-policy",
      `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; form-action 'self'; base-uri 'none'`,
    );
    res.end(html);
  };

  return async (req, res) => {
    const nonce = randomBytes(16).toString("base64");
    const profile = currentProfile();
    const profileId = profile?.profileId;
    const person = profileId ? profile.displayName || profileId : undefined;
    const page = async (status, notice) =>
      send(
        res,
        status,
        renderPage({
          nonce,
          path: CONNECT_PATH,
          person,
          login: profileId ? await readLogin(stateDir, profileId) : undefined,
          ticket: profileId ? issueTicket(profileId) : "",
          notice,
        }),
        nonce,
      );

    if (req.method === "GET" || req.method === "HEAD") {
      await page(200);
      return true;
    }
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("allow", "GET, HEAD, POST");
      res.end();
      return true;
    }
    if (!profileId) {
      await page(403);
      return true;
    }

    let form;
    try {
      form = await readForm(req);
    } catch {
      await page(413, { ok: false, text: "That request was too large." });
      return true;
    }
    if (!redeemTicket(form.get("ticket") ?? "", profileId)) {
      await page(400, { ok: false, text: "This form has expired. Try again." });
      return true;
    }

    if (form.get("action") === "disconnect") {
      await removeLogin(stateDir, profileId);
      log?.info?.(`bitbucket: removed the login of profile ${profileId}`);
      await page(200, { ok: true, text: "Disconnected. The token is deleted from this gateway." });
      return true;
    }

    const user = (form.get("user") ?? "").trim();
    const token = (form.get("token") ?? "").trim();
    if (!/^[^\s@]+@[^\s@]+$/.test(user) || !token || /\s/.test(token)) {
      await page(400, { ok: false, text: "Enter the account e-mail and the API token." });
      return true;
    }
    try {
      const name = await verify(user, token);
      await writeLogin(stateDir, {
        profile: profileId,
        user,
        name,
        token,
        stored: new Date().toISOString(),
      });
      log?.info?.(`bitbucket: stored a login for profile ${profileId}`);
      await page(200, { ok: true, text: `Connected as ${name}.` });
    } catch (error) {
      const rejected = error instanceof BitbucketRejected;
      if (!rejected) log?.warn?.(`bitbucket: could not store a login: ${error?.message ?? error}`);
      await page(rejected ? 400 : 502, {
        ok: false,
        text: rejected ? error.message : "Bitbucket could not be asked just now. Nothing was stored.",
      });
    }
    return true;
  };
}

export default definePluginEntry({
  id: "bitbucket",
  name: "Bitbucket",
  description: "Bitbucket Cloud skill and personal Bitbucket logins",
  register(api) {
    const config = api.pluginConfig ?? {};
    const stateDir = api.runtime.state.resolveStateDir(process.env);
    const getSessionEntry = (params) => api.runtime.agent.session.getSessionEntry(params);
    const log = api.logger;

    api.on("resolve_exec_env", async (event, ctx) => {
      try {
        return await execEnv(
          { stateDir, getSessionEntry, gitIdentity: config.gitIdentity !== false, execLogin: config.execLogin !== false },
          event,
          ctx,
        );
      } catch (error) {
        // Fail to "no login", never to whatever the command asked for.
        log?.warn?.(`bitbucket: no login for this command: ${error?.message ?? error}`);
        return { BITBUCKET_LOGIN_FILE: "", BITBUCKET_CONNECT_PATH: CONNECT_PATH };
      }
    });

    // Publishing a session's worktree as the person who asks, once they
    // confirm. A Control UI calls these with plugins.sessionAction.
    const currentProfile = () => getPluginRuntimeGatewayRequestScope()?.client?.authenticatedUserProfile;
    const publisher = createPublisher({ stateDir, getSessionEntry, currentProfile });
    const payload = (properties) => ({ type: "object", additionalProperties: false, properties });
    api.session.controls.registerSessionAction({
      id: "publish-options",
      description: "What publishing this session's worktree to Bitbucket would push, and with whose login: yours.",
      requiredScopes: ["operator.read"],
      schema: payload({ dest: { type: "string" } }),
      handler: publisher.options,
    });
    api.session.controls.registerSessionAction({
      id: "publish",
      description: "Ask to push this session's worktree branch to Bitbucket and open a draft pull request with your own login. Nothing happens until you confirm.",
      requiredScopes: ["operator.write"],
      schema: payload({ dest: { type: "string" }, title: { type: "string" }, description: { type: "string" }, draft: { type: "boolean" } }),
      handler: publisher.publish,
    });
    api.session.controls.registerSessionAction({
      id: "publish-confirm",
      description: "Confirm a Bitbucket publication you asked for: pushes the branch and opens or finds its pull request.",
      requiredScopes: ["operator.write"],
      schema: { ...payload({ requestId: { type: "string" }, requestDigest: { type: "string" } }), required: ["requestId", "requestDigest"] },
      handler: publisher.confirm,
    });

    api.registerHttpRoute({
      path: CONNECT_PATH,
      auth: "gateway",
      match: "exact",
      handler: createConnectHandler({
        stateDir,
        currentProfile,
        log,
      }),
    });

    if (config.controlUiTab !== false) {
      api.session.controls.registerControlUiDescriptor({
        surface: "tab",
        id: "bitbucket",
        label: "Bitbucket",
        description: "Connect your own Bitbucket account.",
        icon: "git-branch",
        group: "control",
        path: CONNECT_PATH,
      });
    }
  },
});
