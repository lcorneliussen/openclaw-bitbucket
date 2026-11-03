// The "Connect Bitbucket" page. Served to one signed-in person at a time;
// it never shows a stored token.
import { REQUIRED_SCOPES, TOKEN_SETTINGS_URL, missingScopes } from "./scopes.js";

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const STYLE = `
:root { color-scheme: light dark; --line: #8884; --muted: #666; --accent: #2563eb; }
body { font: 15px/1.5 system-ui, sans-serif; margin: 0; padding: 24px 16px; }
main { max-width: 34rem; margin: 0 auto; }
h1 { font-size: 1.25rem; margin: 0 0 4px; }
p { margin: 8px 0; } .muted { color: var(--muted); }
.box { border: 1px solid var(--line); border-radius: 8px; padding: 12px 16px; margin: 16px 0; }
.ok { border-color: #16a34a88; } .bad { border-color: #dc262688; }
label { display: block; margin: 12px 0 4px; font-weight: 600; }
input { font: inherit; width: 100%; box-sizing: border-box; padding: 8px; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: inherit; }
button { font: inherit; margin-top: 16px; padding: 8px 14px; border-radius: 6px; border: 1px solid var(--line); background: var(--accent); color: #fff; cursor: pointer; }
button.plain { background: transparent; color: inherit; }
code { font-size: .9em; } ol { padding-left: 1.2rem; }
.scopes { padding-left: 1.2rem; } .scopes code { overflow-wrap: anywhere; }
a { color: var(--accent); } .warn { border-color: #ca8a0488; }
@media (prefers-color-scheme: dark) { :root { --muted: #aaa; } a { color: #8ab4ff; } }
#framed { display: none; }
#connect-url { overflow-wrap: anywhere; user-select: all; }
`;

function permissionSummary(login) {
  const check = login.scopeCheck;
  const verified = check?.status === "verified";
  let text = "Permissions have not been checked for this saved login.";
  if (verified) text = "Bitbucket reports all six required token scopes. Repository and branch permissions still apply.";
  else if (check?.status === "unknown") text = "The latest check could not verify the full set of token scopes. Bitbucket did not return a usable granted-scope list.";
  else if (check?.status === "missing") text = "The saved token is missing required scopes. Create a replacement using the list below.";
  else if (check?.status === "rejected") text = "Bitbucket rejected the saved credentials. Replace this login to reconnect.";
  const missing = check?.status === "missing" ? `<ul class="scopes">${missingScopes(check.granted).map(s => `<li><code>${s}</code></li>`).join("")}</ul>` : "";
  const when = check?.checkedAt ? `<p class="muted">Last check: ${escapeHtml(new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(check.checkedAt)))} UTC.</p>` : "";
  const title = verified ? "Token permissions verified" : check?.status === "missing" ? "Required token scopes missing" : check?.status === "rejected" ? "Saved login rejected" : check ? "Token permissions unverified" : "Token permissions not checked";
  return `<div class="box ${verified ? "ok" : "warn"}"><p><strong>${title}</strong></p><p>${escapeHtml(text)}</p>${missing}${when}</div>`;
}

// Inside the Control UI the page sits in a sandboxed frame that may only
// read, so the form cannot be sent from there.
const FRAME_SCRIPT = `
const framed = document.getElementById("framed");
if (window.top !== window.self && framed) {
  document.getElementById("forms").style.display = "none";
  const url = document.getElementById("connect-url");
  url.textContent = new URL(url.textContent, window.location.href).href;
  framed.style.display = "block";
}
`;

export function renderPage({ nonce, path, person, login, loginUnreadable = false, ticket, notice }) {
  const body = [];
  body.push(`<h1>Bitbucket</h1>`);
  if (!person) {
    body.push(
      `<div class="box bad"><p>This gateway does not know who you are. Personal Bitbucket logins need a sign-in that identifies each person.</p></div>`,
    );
  } else {
    body.push(`<p class="muted">Signed in to this gateway as ${escapeHtml(person)}.</p>`);
    if (notice) {
      body.push(`<div class="box ${notice.ok ? "ok" : "bad"}"><p>${escapeHtml(notice.text)}</p></div>`);
    }
    body.push(
      loginUnreadable
        ? `<div class="box warn"><p><strong>Saved login unreadable</strong></p><p>Ask the gateway operator to check the login file and its permissions. The stored credential has not been replaced.</p></div>`
        : login
        ? `<div class="box ${login.scopeCheck?.status === "verified" ? "ok" : ""}"><p>${["missing", "rejected"].includes(login.scopeCheck?.status) ? "Saved login for" : "Connected as"} <strong>${escapeHtml(login.name)}</strong> (${escapeHtml(login.user)}), since ${escapeHtml(login.stored.slice(0, 10))}.</p><p class="muted">Commands in your sessions use this account. Token permissions are shown below.</p></div>`
        : `<div class="box"><p>Not connected. Sessions you own cannot push or open pull requests on Bitbucket yet.</p></div>`,
    );
    if (login && !loginUnreadable) body.push(permissionSummary(login));
    body.push(`<div id="framed" class="box"><p>Copy this address into a new browser tab to manage this login:</p><p><code id="connect-url">${escapeHtml(path)}</code></p></div>`);
    body.push(`<div id="forms">`);
    if (!loginUnreadable) {
      if (login) {
        body.push(`<form method="post" action="${escapeHtml(path)}">
<input type="hidden" name="ticket" value="${escapeHtml(ticket)}">
<input type="hidden" name="action" value="check">
<button type="submit" class="plain">Check permissions</button>
</form>`);
      }
      body.push(`<form method="post" action="${escapeHtml(path)}" autocomplete="off">
<input type="hidden" name="ticket" value="${escapeHtml(ticket)}">
<input type="hidden" name="action" value="connect">
<label for="user">Atlassian account e-mail</label>
<input id="user" name="user" type="email" required value="${escapeHtml(login?.user ?? "")}">
<label for="token">Bitbucket API token</label>
<input id="token" name="token" type="password" required autocomplete="off">
<p><a href="${TOKEN_SETTINGS_URL}" target="_blank" rel="noopener noreferrer">Create a Bitbucket API token</a> on Atlassian.</p>
<p class="muted">Choose <strong>Create API token with scopes</strong>, select <strong>Bitbucket</strong>, then select these six scopes:</p>
<ul class="scopes">${REQUIRED_SCOPES.map(scope => `<li><code>${scope}</code></li>`).join("")}</ul>
<button type="submit">${login ? "Replace the login" : "Connect"}</button>
</form>`);
      if (login) {
        body.push(`<form method="post" action="${escapeHtml(path)}">
<input type="hidden" name="ticket" value="${escapeHtml(ticket)}">
<input type="hidden" name="action" value="disconnect">
<button type="submit" class="plain">Disconnect</button>
</form>`);
      }
    }
    body.push(`</div>`);
    body.push(
      `<p class="muted">The token is stored on the gateway, not in your browser. Disconnecting deletes it here; revoke it at Atlassian as well if it should stop working everywhere.</p>`,
    );
  }
  // Gateway security headers can override ours with no-referrer. Set the
  // document policy too, so same-origin form POSTs keep a non-null Origin.
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="referrer" content="same-origin">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bitbucket</title><style nonce="${nonce}">${STYLE}</style></head>
<body><main>${body.join("\n")}</main><script nonce="${nonce}">${FRAME_SCRIPT}</script></body></html>
`;
}
