import { missingScopes, scopeCheck, scopeList } from "./scopes.js";

// An identity read also supplies scope evidence when Bitbucket returns it.
const API = "https://api.bitbucket.org/2.0/user";

export class BitbucketRejected extends Error {}
export class BitbucketUnavailable extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}
export class BitbucketScopesMissing extends BitbucketRejected {
  constructor(granted) {
    const check = scopeCheck(granted);
    super(`Token is missing required scopes: ${missingScopes(check.granted).join(", ")}. Create a replacement token with all six required scopes.`);
    this.scopeCheck = check;
  }
}

function grantedScopes(response, body) {
  const header = response.headers?.get?.("x-oauth-scopes");
  if (header?.trim()) {
    const scopes = scopeList(header.trim().split(/[,\s]+/));
    if (scopes) return scopes;
  }
  // Scope-denial responses may name the granted scopes. Never mistake the
  // endpoint's required/accepted scopes for what this credential grants.
  const detail = body?.error?.detail ?? body?.error?.data;
  if (scopeList(detail?.required)?.length) return scopeList(detail?.granted);
  return undefined;
}

// Returns {name, scopeCheck}. Missing grants use BitbucketScopesMissing;
// other denials use BitbucketRejected (401 sets credentialsRejected).
// BitbucketUnavailable.status is the response status for provider failures.
export async function inspectToken(user, token, fetchImpl = fetch, signal) {
  let response;
  try {
    response = await fetchImpl(API, {
      headers: {
        accept: "application/json",
        authorization: `Basic ${Buffer.from(`${user}:${token}`).toString("base64")}`,
      },
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    });
  } catch {
    throw new BitbucketUnavailable("Bitbucket could not be reached. Try again later.");
  }
  if (response.status === 401) throw Object.assign(new BitbucketRejected("Bitbucket did not accept this e-mail and token."), { credentialsRejected: true });
  if (response.status === 429) throw new BitbucketUnavailable("Bitbucket is rate-limiting requests. Wait before checking again.", 429);
  if (!response.ok && response.status !== 403) throw new BitbucketUnavailable(`Bitbucket answered ${response.status}. Try again later.`);
  let body;
  try { body = await response.json(); } catch {
    if (response.status !== 403) throw new BitbucketUnavailable("Bitbucket returned an unreadable response.");
  }
  if ((!body || typeof body !== "object" || Array.isArray(body)) && response.status !== 403) throw new BitbucketUnavailable("Bitbucket returned an unreadable response.");
  const check = scopeCheck(grantedScopes(response, body));
  if (check.status === "missing") throw new BitbucketScopesMissing(check.granted);
  if (response.status === 403) throw Object.assign(new BitbucketRejected("Bitbucket denied access. Check the token's scopes and your account's access or organization restrictions."), { scopeCheck: scopeCheck() });
  return { name: String(body.display_name || body.nickname || user), scopeCheck: check };
}

// Returns the display name using the same validation as inspectToken.
export async function verifyToken(user, token, fetchImpl = fetch) {
  return (await inspectToken(user, token, fetchImpl)).name;
}
