// Bitbucket for OpenClaw: the skill in skills/, and personal logins.
//
// Each signed-in person stores their own Bitbucket API token on a page the
// gateway serves to them. Before every `exec` the gateway asks this plugin
// for environment; the answer names the login of the person who owns the
// session. The agent neither supplies nor chooses that identity.
import { randomBytes } from "node:crypto";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { getPluginRuntimeGatewayRequestScope } from "openclaw/plugin-sdk/plugin-runtime";
import { loginFile, readLogin } from "./lib/logins.js";
import { renderPage } from "./lib/page.js";
import { createPublisher } from "./lib/publish.js";
import { createConnectionService } from "./lib/connection.js";
import { REQUIRED_SCOPES, TOKEN_SETTINGS_URL } from "./lib/scopes.js";

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

// Compatibility adapter for explicitly authenticated HTTP consumers. The
// registered browser URL below is redirect-only. Tickets bind each legacy
// form to its authenticated person and block cross-site credential changes.
export function createConnectHandler({ currentProfile, connection, ...options }) {
  connection ??= createConnectionService(options);
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
    const page = async (status, notice) => {
      const model = await connection.snapshot(profile, status, notice);
      send(res, model.status, renderPage({ ...model, nonce, path: CONNECT_PATH, ticket: profileId ? issueTicket(profileId) : "" }), nonce);
    };

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

    const model = await connection.run(profile, form);
    send(res, model.status, renderPage({ ...model, nonce, path: CONNECT_PATH, ticket: issueTicket(profileId) }), nonce);
    return true;
  };
}

// Authenticated account methods use the requester's profile, never a submitted ID.
export function registerConnectionMethods(api, { connection, currentProfile, enabled }) {
  for (const action of ["get", "connect", "check", "disconnect"]) {
    api.registerGatewayMethod(`bitbucket.connection.${action}`, async ({ params = {}, respond }) => {
      const allowed = action === "connect" ? ["user", "token"] : [];
      if (!params || typeof params !== "object" || Array.isArray(params) || Object.keys(params).some(k => !allowed.includes(k)) ||
          action === "connect" && (typeof params.user !== "string" || params.user.length > 320 || typeof params.token !== "string" || params.token.length > 8192)) {
        respond(false, undefined, { code:"INVALID_REQUEST", message:"Invalid Bitbucket connection request." }); return;
      }
      const profile = currentProfile();
      if (!profile?.profileId) { respond(true, {status:403,enabled,notice:{ok:false,text:"Sign in to OpenClaw before managing a personal Bitbucket login."}}); return; }
      try {
        const model = action === "get" ? await connection.snapshot(profile) : await connection.run(profile, new URLSearchParams({ ...params, action }));
        respond(true, { ...model, enabled, requiredScopes:REQUIRED_SCOPES, tokenSettingsUrl:TOKEN_SETTINGS_URL });
      } catch {
        respond(false, undefined, {code:"UNAVAILABLE",message:"The Bitbucket connection could not be read. Try again later."});
      }
    }, { scope: action === "get" ? "operator.read" : "operator.write" });
  }
}

export default definePluginEntry({
  id: "bitbucket",
  name: "Bitbucket",
  description: "Bitbucket Cloud skill and personal Bitbucket logins",
  register(api) {
    const config = api.pluginConfig ?? {};
    const stateDir = api.runtime.state.resolveStateDir(process.env);
    // Keep older hosts supported, but never retry a failed async read
    // through the deprecated method.
    const sessions = api.runtime.agent.session;
    const getSessionEntry = async (params) => typeof sessions.getSessionEntryAsync === "function"
      ? sessions.getSessionEntryAsync(params) : sessions.getSessionEntry(params);
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
    const connection = createConnectionService({ stateDir, log });
    registerConnectionMethods(api, {connection,currentProfile,enabled:config.controlUiTab !== false});
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

    // The old browser URL is now a public redirect, not a credential endpoint.
    // No request profile, body or saved login is read here; POST is refused.
    const base = (api.config?.gateway?.controlUi?.basePath ?? "").replace(/^\/+|\/+$/g, "");
    api.registerHttpRoute({
      path: CONNECT_PATH,
      auth: "plugin",
      match: "exact",
      handler: async (req, res) => {
        res.setHeader("cache-control", "no-store");
        if (req.method === "GET" || req.method === "HEAD") {
          res.statusCode = 302;
          res.setHeader("location", `${base ? "/"+base : ""}/plugin?plugin=bitbucket&id=account`);
        } else {
          res.statusCode = 405;
          res.setHeader("allow", "GET, HEAD");
          res.setHeader("content-type", "text/plain; charset=utf-8");
          res.end("Open the Bitbucket page in the Control UI to manage your connection.");
          return true;
        }
        res.end();
        return true;
      },
    });

    // Native navigation is registered by the browser entry after checking config.
  },
});
