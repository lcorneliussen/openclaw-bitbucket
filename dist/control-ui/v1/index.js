// Account management stays in the authenticated parent UI, outside read-only frames.
const node = (tag, props = {}, ...children) => {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...children.filter((c) => c != null));
  return el;
};
const style = (el, value) => ((el.style.cssText = value), el);
const method = (action) => `bitbucket.connection.${action}`;
const fieldStyle =
  "display:block;width:100%;box-sizing:border-box;background:var(--bg,transparent);color:var(--text,inherit);border:1px solid var(--border,#8886);border-radius:6px;padding:8px;font:inherit";
const button = (text, run) => {
  const el = style(
    node("button", { type: "button", textContent: text }),
    "font:inherit;padding:6px 12px;border:1px solid var(--border,#8886);border-radius:6px;background:var(--bg-accent,transparent);color:var(--text,inherit);cursor:pointer",
  );
  el.onclick = run;
  return el;
};
export function mountAccount(root, ctx) {
  const host = ctx.host;
  let disposed = false,
    busy = false,
    generation = 0,
    model,
    error = "",
    signature;
  let invalidCredentials = false;
  const email = node("input", {
    type: "email",
    name: "user",
    required: true,
    autocomplete: "email",
    maxLength: 320,
  });
  const token = node("input", {
    type: "password",
    name: "token",
    required: true,
    autocomplete: "off",
    maxLength: 8192,
  });
  const notice = style(
    node("p", { role: "status" }),
    "min-height:3em;margin:0;font-size:13px;line-height:1.5",
  );
  const globalNotice = node("p", { role: "status" });
  const summary = node("p");
  const permissions = node("p");
  const scopes = node("ul");
  const settings = node("a", {
    textContent: "Create a scoped Bitbucket API token",
    target: "_blank",
    rel: "noopener noreferrer",
  });
  const form = node("form", { autocomplete: "off" });
  const submit = button("Connect", () => {});
  submit.type = "submit";
  const check = button("Check permissions", () => invoke("check"));
  const disconnect = button("Disconnect", () => invoke("disconnect"));
  notice.id = "bitbucket-connection-notice";
  token.setAttribute("aria-describedby", notice.id);
  settings.style.cssText = "color:var(--accent,#8ab4ff);font-size:13px";
  scopes.style.cssText =
    "margin:8px 0 0;padding-left:18px;font:13px/1.6 var(--mono,ui-monospace,SFMono-Regular,monospace)";
  const help = node(
    "div",
    {},
    settings,
    node("p", {
      textContent:
        "Unscoped API tokens won’t work. Choose “Create API token with scopes”, select Bitbucket, then grant all six scopes:",
    }),
    scopes,
  );
  help.style.cssText = "font-size:13px;color:var(--text,inherit)";
  form.append(
    node("label", {}, "Atlassian account email", style(email, fieldStyle)),
    node("label", {}, "Scoped Bitbucket API token", style(token, fieldStyle)),
    notice,
    help,
    submit,
  );
  submit.style.fontWeight = "600";
  submit.style.borderColor = "var(--accent,#8888)";
  submit.style.background = "var(--accent-soft,rgba(120,160,220,.12))";
  form.style.cssText = "display:grid;gap:12px;max-width:440px";
  const actions = style(
    node("div", {}, check, disconnect),
    "display:flex;gap:8px;flex-wrap:wrap;margin:12px 0",
  );
  const section = style(
    node(
      "section",
      {},
      node("h1", { textContent: "Bitbucket" }),
      summary,
      globalNotice,
      permissions,
      actions,
      form,
      style(
        node("p", {
          textContent:
            "Saved tokens remain on the gateway. Disconnecting removes your saved login; revoke the token at Atlassian to invalidate it.",
        }),
        "color:var(--muted,#888);font-size:12px",
      ),
    ),
    "padding:20px;max-width:480px;box-sizing:border-box;font:inherit;color:var(--text,inherit);overflow-wrap:anywhere",
  );
  root.replaceChildren(section);
  function render() {
    const writable = host.connection.connected && host.connection.canWrite;
    const unavailable = !model || !model.person || model.loginUnreadable;
    const savedOnly = ["missing", "rejected"].includes(
      model?.login?.scopeCheck?.status,
    );
    summary.textContent = model?.login
      ? `${savedOnly ? "Saved login for" : "Connected as"} ${model.login.name} (${model.login.user}).`
      : model?.loginUnreadable
        ? "Saved login unreadable. Ask the gateway operator to check its permissions."
        : model?.person
          ? `Not connected. Signed in to OpenClaw as ${model.person}.`
          : "Sign in to OpenClaw to manage your Bitbucket connection.";
    notice.textContent =
      error || model?.notice?.text || (busy ? "Working…" : "");
    globalNotice.textContent = notice.textContent;
    globalNotice.hidden = !unavailable;
    globalNotice.style.display = unavailable ? "block" : "none";
    notice.style.color =
      error || model?.notice?.ok === false
        ? "var(--danger,#e66)"
        : "var(--muted,#888)";
    for (const input of [email, token]) {
      input.setAttribute("aria-invalid", String(invalidCredentials));
      input.style.borderColor = invalidCredentials ? "var(--danger,#e66)" : "";
    }
    globalNotice.style.color = notice.style.color;
    const checkState = model?.login?.scopeCheck?.status;
    permissions.textContent = !model?.login
      ? ""
      : checkState === "verified"
        ? "Bitbucket reports all required scopes. Repository permissions still apply."
        : checkState === "missing"
          ? "Required token scopes are missing. Replace the token using the list below."
          : checkState === "rejected"
            ? "Bitbucket rejected the saved credentials."
            : "Token permissions have not been fully verified.";
    form.hidden = unavailable;
    form.style.display = unavailable ? "none" : "grid";
    actions.hidden = !model?.login || unavailable;
    actions.style.display = actions.hidden ? "none" : "flex";
    for (const el of [email, token, submit, check, disconnect])
      el.disabled = busy || unavailable || !writable;
    submit.textContent = busy
      ? "Working…"
      : model?.login
        ? "Replace login"
        : "Connect";
    if (!writable && model?.person && !error && !model?.notice)
      notice.textContent =
        "This connection is read-only. Sign in with write access to change the login.";
    section.setAttribute("aria-busy", String(busy));
  }
  function apply(next, action) {
    model = next;
    if (action === "get" || (action === "connect" && next.notice?.ok))
      email.value = next.login?.user ?? email.value ?? "";
    // This destination is fixed by the plugin, never a token-bearing URL.
    settings.href =
      "https://id.atlassian.com/manage-profile/security/api-tokens";
    scopes.replaceChildren(
      ...(next.requiredScopes ?? []).map((s) =>
        node("li", {}, node("code", { textContent: s })),
      ),
    );
  }
  async function invoke(action, params = {}) {
    if (
      disposed ||
      busy ||
      !host.connection.connected ||
      (action !== "get" && !host.connection.canWrite)
    )
      return;
    const epoch = generation;
    busy = true;
    invalidCredentials = false;
    error = "";
    if (model) model = { ...model, notice: undefined };
    render();
    try {
      const next = await host.request(method(action), params);
      if (disposed || epoch !== generation) return;
      invalidCredentials = action === "connect" && next.status === 400;
      apply(next, action);
    } catch {
      if (!disposed && epoch === generation)
        error =
          "The Bitbucket request failed. Check your OpenClaw connection and try again.";
    } finally {
      if (!disposed && epoch === generation) {
        busy = false;
        render();
      }
    }
  }
  form.onsubmit = (event) => {
    event.preventDefault();
    if (busy || !host.connection.canWrite) return;
    const params = { user: email.value, token: token.value };
    token.value = "";
    void invoke("connect", params);
  };
  const refreshConnection = () => {
    const key = `${host.connection.connected}:${host.connection.canRead}:${host.connection.canWrite}`;
    if (key === signature) return;
    signature = key;
    generation++;
    busy = false;
    model = undefined;
    invalidCredentials = false;
    token.value = "";
    email.value = "";
    error = "";
    render();
    if (host.connection.connected && host.connection.canRead)
      void invoke("get");
  };
  const stop = host.subscribe(refreshConnection);
  refreshConnection();
  return {
    dispose() {
      disposed = true;
      generation++;
      token.value = "";
      email.value = "";
      stop();
      root.replaceChildren();
    },
  };
}
export default {
  id: "bitbucket",
  activate(host) {
    let disposed = false,
      generation = 0,
      signature,
      stopNav,
      retryTimer;
    const stopPage = host.ui.registerPage({
      id: "account",
      label: "Bitbucket",
      mount: mountAccount,
    });
    const probe = async (epoch, attempt = 0) => {
      try {
        const data = await host.request(method("get"), {});
        if (disposed || epoch !== generation) return;
        if (data.enabled)
          stopNav ??= host.ui.registerNavigation({
            id: "account",
            label: "Bitbucket",
            page: { id: "account" },
            icon: "git-branch",
            order: 50,
          });
      } catch {
        // Read-only startup probes retry twice; credential writes never retry.
        if (!disposed && epoch === generation && attempt < 2) {
          retryTimer = setTimeout(() => {
            retryTimer = undefined;
            void probe(epoch, attempt + 1);
          }, [250, 1000][attempt]);
        }
      }
    };
    const sync = () => {
      const key = `${host.connection.connected}:${host.connection.canRead}`;
      if (key === signature) return;
      signature = key;
      const epoch = ++generation;
      clearTimeout(retryTimer);
      retryTimer = undefined;
      stopNav?.();
      stopNav = undefined;
      if (host.connection.connected && host.connection.canRead)
        void probe(epoch);
    };
    const stop = host.subscribe(sync);
    sync();
    return () => {
      disposed = true;
      generation++;
      clearTimeout(retryTimer);
      stop();
      stopNav?.();
      stopPage();
    };
  },
};
