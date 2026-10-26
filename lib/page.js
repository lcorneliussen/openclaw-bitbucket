// The "Connect Bitbucket" page. Served to one signed-in person at a time;
// it never shows a stored token.
const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const STYLE = `
:root { color-scheme: light dark; --line: #8884; --muted: #8a8a8a; --accent: #2563eb; }
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
#framed { display: none; }
#connect-url { overflow-wrap: anywhere; user-select: all; }
`;

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

export function renderPage({ nonce, path, person, login, ticket, notice }) {
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
      login
        ? `<div class="box ok"><p>Connected as <strong>${escapeHtml(login.name)}</strong> (${escapeHtml(login.user)}), since ${escapeHtml(login.stored.slice(0, 10))}.</p><p class="muted">Commands in your sessions push and open pull requests as this account.</p></div>`
        : `<div class="box"><p>Not connected. Sessions you own cannot push or open pull requests on Bitbucket yet.</p></div>`,
    );
    body.push(`<div id="framed" class="box"><p>Copy this address into a new browser tab to connect or disconnect:</p><p><code id="connect-url">${escapeHtml(path)}</code></p></div>`);
    body.push(`<div id="forms">`);
    body.push(`<form method="post" action="${escapeHtml(path)}" autocomplete="off">
<input type="hidden" name="ticket" value="${escapeHtml(ticket)}">
<input type="hidden" name="action" value="connect">
<label for="user">Atlassian account e-mail</label>
<input id="user" name="user" type="email" required value="${escapeHtml(login?.user ?? "")}">
<label for="token">Bitbucket API token</label>
<input id="token" name="token" type="password" required autocomplete="off">
<p class="muted">Create one under Atlassian account settings, Security, API tokens, for the app Bitbucket. Scopes: repositories read and write, pull requests read and write, pipelines read.</p>
<button type="submit">${login ? "Replace the login" : "Connect"}</button>
</form>`);
    if (login) {
      body.push(`<form method="post" action="${escapeHtml(path)}">
<input type="hidden" name="ticket" value="${escapeHtml(ticket)}">
<input type="hidden" name="action" value="disconnect">
<button type="submit" class="plain">Disconnect</button>
</form>`);
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
