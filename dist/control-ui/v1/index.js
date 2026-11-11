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
    busyAction = null,
    generation = 0,
    model,
    error = "",
    signature;
  let mode = "overview",
    checkState = "idle",
    checkMessage = "",
    checkAttemptedAt,
    checkOnOpen = true,
    invalidCredentials = false;
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
  const title = style(
    node("span", { role: "status" }),
    "font-size:12px;font-weight:600;line-height:1.4",
  );
  const statusIcon = node("span");
  statusIcon.setAttribute("aria-hidden", "true");
  const statusBadge = style(
    node("div", {}, statusIcon, title),
    "display:inline-flex;align-items:baseline;gap:6px;border:1px solid var(--border,#8886);border-radius:99px;padding:3px 9px;max-width:100%",
  );
  const account = style(
    node("p"),
    "font-size:13px;line-height:1.5;margin:0;overflow-wrap:anywhere",
  );
  const tokenInfo = style(
    node("span"),
    "display:inline-block;justify-self:start;border:1px solid var(--border,#8886);border-radius:99px;padding:2px 7px;font-size:12px;line-height:1.4",
  );
  const permissions = style(
    node("p"),
    "font-size:13px;line-height:1.5;margin:0",
  );
  const checkedAt = style(node("p"), "font-size:12px;line-height:1.4;margin:0");
  const timeLabelNode = style(
    node("p"),
    "font-size:12px;font-weight:600;margin:0 0 3px",
  );
  const readOnly = style(
    node("p"),
    "font-size:12px;line-height:1.5;margin:0;padding-top:10px;border-top:1px solid var(--border,#8886)",
  );
  const field = (label, value) =>
    style(
      node(
        "div",
        {},
        style(
          node("span", { textContent: label }),
          "font-size:13px;font-weight:600",
        ),
        value,
      ),
      "display:grid;grid-template-columns:58px minmax(0,1fr);align-items:baseline;gap:10px",
    );
  const accountRow = field("Account", account),
    tokenRow = field("Token", tokenInfo);
  const noticeMark = node("span");
  noticeMark.setAttribute("aria-hidden", "true");
  const checkNotice = style(
    node("div", {}, noticeMark, permissions),
    "display:grid;grid-template-columns:16px minmax(0,1fr);align-items:baseline;gap:8px;border:1px solid var(--border,#8886);border-radius:6px;padding:8px",
  );
  const permissionHeading = style(
    node("h3"),
    "font-size:13px;font-weight:600;margin:0 0 6px",
  );
  const permissionCaption = style(
    node("p"),
    "font-size:12px;line-height:1.5;margin:0 0 6px",
  );
  const permissionList = style(
    node("ul"),
    "list-style:none;padding:0;margin:0",
  );
  let extraCount = 0,
    extraExpanded = false;
  const extraList = style(
    node("ul", { id: "bitbucket-extra-grants" }),
    "list-style:none;padding:0;margin:0",
  );
  const extraHeading = style(
    node("h3"),
    "font-size:13px;font-weight:600;margin:0",
  );
  const extraToggle = button("Show all", () => {
    extraExpanded = !extraExpanded;
    renderExtraVisibility();
  });
  extraToggle.style.cssText += ";font-size:12px;padding:3px 8px";
  extraToggle.setAttribute("aria-controls", extraList.id);
  const extraGroup = style(
    node(
      "div",
      {},
      style(
        node("div", {}, extraHeading, extraToggle),
        "display:flex;align-items:center;justify-content:space-between;gap:8px;margin:12px 0 4px",
      ),
      style(
        node("p", { textContent: "Not required by this plugin." }),
        "font-size:12px;margin:0 0 6px",
      ),
      extraList,
    ),
    "margin:0",
  );
  function renderExtraVisibility() {
    const expandable = extraCount > 4,
      visible = extraCount > 0 && (!expandable || extraExpanded);
    extraHeading.textContent = `Additional grants (${extraCount})`;
    show(extraToggle, expandable);
    show(extraList, visible);
    extraToggle.textContent = visible ? "Hide" : "Show all";
    extraToggle.setAttribute("aria-expanded", String(visible));
  }
  const permissionPanel = style(
    node(
      "div",
      {},
      permissionHeading,
      permissionCaption,
      permissionList,
      extraGroup,
    ),
    "padding-top:12px;border-top:1px solid var(--border,#8886)",
  );
  const status = style(
    node(
      "div",
      {},
      style(
        node(
          "div",
          {},
          style(
            node("h2", { textContent: "Connection" }),
            "font-size:14px;font-weight:600;margin:0",
          ),
          statusBadge,
        ),
        "display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap",
      ),
      style(node("div", {}, accountRow, tokenRow), "display:grid;gap:10px"),
      checkNotice,
      permissionPanel,
    ),
    "display:grid;gap:12px;border:1px solid var(--border,#8886);border-radius:8px;padding:14px 16px;margin:16px 0;color:var(--text,inherit)",
  );
  const check = button("Check again", () => {
    if (mode === "overview")
      void invoke(model?.login && host.connection.canWrite ? "check" : "get");
  });
  check.style.marginLeft = "auto";
  const timeBlock = node("div", {}, timeLabelNode, checkedAt);
  const statusFooter = style(
    node("div", {}, timeBlock, check),
    "display:flex;align-items:center;justify-content:space-between;gap:8px;padding-top:10px;border-top:1px solid var(--border,#8886)",
  );
  status.append(statusFooter, readOnly);
  let permissionKey;
  function renderPermissionRows(required, reported, known, current) {
    const key = JSON.stringify({ required, reported, known, current });
    if (key === permissionKey) return;
    permissionKey = key;
    const actions = {
      read: "Read",
      write: "Write",
      admin: "Administer",
      delete: "Delete",
    };
    const resources = {
      user: "account details",
      repository: "repositories",
      pullrequest: "pull requests",
      pipeline: "pipelines",
      workspace: "workspaces",
      project: "projects",
      snippet: "snippets",
      webhook: "webhooks",
      runner: "runners",
      issue: "issues",
    };
    const row = (scope) => {
      const granted = known && reported.includes(scope),
        state = known ? (granted ? "Granted" : "Missing") : "Unknown";
      const mark = style(
        node("span", { textContent: known ? (granted ? "✓" : "×") : "?" }),
        `font-size:14px;color:${known && !granted ? "var(--danger,#c33)" : granted && current ? "var(--success,#26804b)" : "inherit"}`,
      );
      mark.setAttribute("aria-hidden", "true");
      const [action, resource] = scope.split(":");
      const labelText =
        actions[action] && resources[resource]
          ? `${actions[action]} ${resources[resource]}`
          : scope;
      const label = node("span", { textContent: labelText, title: scope });
      label.style.cssText = "min-width:0;overflow-wrap:anywhere;font:inherit";
      const item = style(
        node(
          "li",
          {},
          mark,
          label,
          style(
            node("span", { textContent: state }),
            "font-size:11px;font-weight:600;white-space:nowrap;text-align:right",
          ),
        ),
        "display:grid;grid-template-columns:16px minmax(0,1fr) 54px;align-items:baseline;gap:6px;font-size:12px;line-height:1.5;padding:4px 0",
      );
      item.setAttribute(
        "aria-label",
        `${scope}: ${state}${known && !current ? " (saved result)" : ""}`,
      );
      return item;
    };
    permissionList.replaceChildren(...required.map(row));
    const extra = known ? reported.filter((s) => !required.includes(s)) : [];
    extraList.replaceChildren(...extra.map(row));
    extraCount = extra.length;
    renderExtraVisibility();
    show(extraGroup, extraCount > 0);
  }
  const connect = button("Connect Bitbucket", () => choose("connect"));
  const replace = button("Replace token…", () => choose("replace"));
  const disconnect = button("Disconnect…", () => choose("disconnect"));
  const actions = style(
    node("div", {}, connect, replace, disconnect),
    "display:flex;gap:8px;flex-wrap:wrap;margin:12px 0",
  );
  const form = node("form", { autocomplete: "off" });
  const formTitle = style(node("h2"), "font-size:16px;margin:0");
  const formIntro = node("p");
  formIntro.style.cssText = "font-size:13px;margin:0";
  const notice = style(
    node("p", { role: "status" }),
    "min-height:3em;margin:0;font-size:13px;line-height:1.5",
  );
  notice.id = "bitbucket-connection-notice";
  token.setAttribute("aria-describedby", notice.id);
  // Token creation uses a fixed Atlassian URL, without account data or tokens.
  const settings = node("a", {
    textContent: "Create a scoped Bitbucket API token",
    href: "https://id.atlassian.com/manage-profile/security/api-tokens",
    target: "_blank",
    rel: "noopener noreferrer",
  });
  settings.style.cssText = "color:var(--accent,#8ab4ff);font-size:13px";
  const scopes = style(
    node("ul"),
    "margin:8px 0 0;padding-left:18px;font:13px/1.6 var(--mono,ui-monospace,SFMono-Regular,monospace)",
  );
  const help = style(
    node(
      "div",
      {},
      settings,
      node("p", {
        textContent:
          "Unscoped API tokens won’t work. Choose “Create API token with scopes”, select Bitbucket, then grant all six scopes:",
      }),
      scopes,
    ),
    "font-size:13px;color:var(--text,inherit)",
  );
  const submit = button("Connect", () => {});
  submit.type = "submit";
  submit.style.fontWeight = "600";
  submit.style.borderColor = "var(--accent,#8888)";
  const cancel = button("Cancel", () => choose("overview"));
  form.append(
    formTitle,
    formIntro,
    node("label", {}, "Atlassian account email", style(email, fieldStyle)),
    node("label", {}, "Scoped Bitbucket API token", style(token, fieldStyle)),
    help,
    notice,
    style(
      node("div", {}, submit, cancel),
      "display:flex;gap:8px;flex-wrap:wrap",
    ),
    style(
      node("p", {
        textContent:
          "The token stays on the gateway; its value is never displayed here.",
      }),
      "font-size:12px;color:var(--muted,#888);margin:0",
    ),
  );
  form.style.cssText = "display:grid;gap:12px;margin-top:24px";
  const confirm = button("Disconnect Bitbucket", () => {
    if (mode === "disconnect") void invoke("disconnect");
  });
  confirm.style.borderColor = "var(--danger,#c33)";
  const keep = button("Cancel", () => choose("overview"));
  const disconnectNotice = style(
    node("p", { role: "status" }),
    "font-size:13px;min-height:3em;color:var(--danger,#e66)",
  );
  const disconnectPanel = style(
    node(
      "div",
      {},
      style(
        node("h2", { textContent: "Disconnect Bitbucket?" }),
        "font-size:16px;margin:0 0 8px",
      ),
      node("p", {
        textContent:
          "Remove your saved token from this gateway. This does not revoke the token at Atlassian or delete any repository work.",
      }),
      disconnectNotice,
      style(
        node("div", {}, confirm, keep),
        "display:flex;gap:8px;flex-wrap:wrap",
      ),
    ),
    "margin-top:24px;font-size:13px",
  );
  const section = style(
    node(
      "section",
      {},
      node("h1", { textContent: "Bitbucket" }),
      status,
      actions,
      form,
      disconnectPanel,
    ),
    "padding:20px;max-width:480px;box-sizing:border-box;font:inherit;color:var(--text,inherit);overflow-wrap:anywhere",
  );
  root.replaceChildren(section);
  const show = (el, visible, display = "block") => {
    el.hidden = !visible;
    el.style.display = visible ? display : "none";
  };
  function render() {
    const connected = host.connection.connected,
      writable = connected && host.connection.canWrite;
    const available = !!model?.person && !model.loginUnreadable;
    const saved = !!model?.login,
      editing = ["connect", "replace"].includes(mode);
    const scopesState = model?.login?.scopeCheck?.status;
    const evidence = model?.login?.scopeCheck;
    const known =
      ["verified", "missing"].includes(scopesState) &&
      Array.isArray(evidence?.granted);
    const currentGrants =
      checkState === "fresh" && scopesState === "verified" && known;
    const savedFailure =
      checkState === "idle" && ["missing", "rejected"].includes(scopesState);
    const savedTitle =
      scopesState === "missing"
        ? "Missing scopes (saved)"
        : scopesState === "rejected"
          ? "Token rejected (saved)"
          : "Token saved";
    const savedDetail =
      scopesState === "missing"
        ? "Required scopes were missing at the last saved check."
        : scopesState === "rejected"
          ? "Bitbucket rejected this token at the last saved check."
          : "";
    title.textContent = !connected
      ? "OpenClaw disconnected"
      : !host.connection.canRead
        ? "Read access required"
        : !model
          ? error
            ? "Unable to load connection"
            : "Loading connection…"
          : !model.person
            ? "Sign in required"
            : model.loginUnreadable
              ? "Saved token unreadable"
              : !saved
                ? "Not connected"
                : checkState === "pending"
                  ? "Checking…"
                  : checkState === "failed"
                    ? "Needs attention"
                    : checkState !== "fresh"
                      ? savedTitle
                      : currentGrants
                        ? "Connected"
                        : scopesState === "missing"
                          ? "Required permissions missing"
                          : scopesState === "rejected"
                            ? "Token rejected"
                            : "Scopes unknown";
    account.textContent = model?.login
      ? `${model.login.name} (${model.login.user})`
      : model?.person
        ? `Signed in to OpenClaw as ${model.person}.`
        : "";
    tokenInfo.textContent = saved
      ? "Saved on gateway"
      : model?.loginUnreadable
        ? "Unreadable"
        : available
          ? "Not saved"
          : "Unknown";
    permissions.textContent = model?.loginUnreadable
      ? "Ask the gateway operator to check the saved login file and its permissions."
      : !model?.person && model
        ? "Sign in to OpenClaw to manage your personal connection."
        : checkState === "pending"
          ? "Checking the saved token with Bitbucket…"
          : checkState === "failed"
            ? checkMessage || "The current connection could not be verified."
            : checkState === "fresh" && saved
              ? scopesState === "verified"
                ? ""
                : scopesState === "missing"
                  ? "Required scopes are missing. Replace the token to reconnect."
                  : scopesState === "rejected"
                    ? "Bitbucket rejected the saved token. Replace it to reconnect."
                    : "The full granted-scope list could not be verified."
              : mode === "overview"
                ? error || (!saved ? model?.notice?.text || "" : savedDetail)
                : saved
                  ? savedDetail
                  : "";
    statusIcon.textContent =
      checkState === "pending"
        ? "↻"
        : currentGrants
          ? "✓"
          : checkState === "failed" || savedFailure
            ? "!"
            : saved
              ? "i"
              : "?";
    statusBadge.style.borderColor =
      checkState === "failed" || savedFailure
        ? "var(--danger,#c33)"
        : currentGrants
          ? "var(--success,#26804b)"
          : "var(--border,#8886)";
    noticeMark.textContent =
      checkState === "pending"
        ? "↻"
        : checkState === "failed" || savedFailure
          ? "!"
          : "i";
    const required = model?.requiredScopes ?? [],
      reported = known ? evidence.granted : [];
    permissionHeading.textContent = known
      ? currentGrants
        ? "Token permissions"
        : "Saved permission results"
      : "Required permissions";
    permissionCaption.textContent = !known
      ? "Bitbucket has not reported individual scope grants."
      : !currentGrants &&
          ["pending", "failed"].includes(checkState) &&
          evidence?.checkedAt
        ? `From saved check: ${new Date(evidence.checkedAt).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })}`
        : "";
    show(permissionCaption, !!permissionCaption.textContent);
    renderPermissionRows(required, reported, known, currentGrants);
    show(permissionPanel, available && saved);
    const stamp =
      checkState === "failed"
        ? checkAttemptedAt
        : model?.login?.scopeCheck?.checkedAt;
    const timeLabel =
      checkState === "failed"
        ? "Last attempt"
        : checkState === "fresh"
          ? "Last checked"
          : "Saved check";
    timeLabelNode.textContent = timeLabel;
    checkedAt.textContent =
      stamp && Number.isFinite(Date.parse(stamp))
        ? new Date(stamp).toLocaleString(undefined, {
            dateStyle: "short",
            timeStyle: "short",
          })
        : "";
    readOnly.textContent =
      available && !writable
        ? "Read-only access. Sign in with write access to check permissions or change this connection."
        : "";
    show(accountRow, !!account.textContent, "grid");
    show(tokenRow, !!model?.person, "grid");
    show(checkNotice, !!permissions.textContent, "grid");
    show(timeBlock, !!checkedAt.textContent);
    show(statusFooter, !!checkedAt.textContent || saved || !!error, "flex");
    show(readOnly, !!readOnly.textContent);
    show(
      actions,
      mode === "overview" && connected && host.connection.canRead && writable,
      "flex",
    );
    show(check, mode === "overview" && (!!saved || !!error));
    check.textContent = writable && saved ? "Check again" : "Refresh status";
    check.disabled = !!busyAction;
    show(connect, available && !saved);
    show(replace, available && saved);
    show(disconnect, available && saved);
    for (const el of [
      connect,
      replace,
      disconnect,
      email,
      token,
      submit,
      cancel,
      confirm,
      keep,
    ])
      el.disabled = !!busyAction || !available || !writable;
    show(form, editing && available, "grid");
    show(disconnectPanel, mode === "disconnect" && available);
    disconnectNotice.textContent =
      error || (model?.notice?.ok === false ? model.notice.text : "");
    formTitle.textContent =
      mode === "replace" ? "Replace token" : "Connect Bitbucket";
    formIntro.textContent =
      mode === "replace"
        ? "Your existing token stays saved until a replacement is verified and saved."
        : "Create a scoped token, then connect your Bitbucket account.";
    submit.textContent =
      busyAction === "connect"
        ? "Saving…"
        : mode === "replace"
          ? "Replace token"
          : "Connect";
    notice.textContent = error || model?.notice?.text || "";
    notice.style.color =
      error || model?.notice?.ok === false
        ? "var(--danger,#e66)"
        : "var(--muted,#888)";
    for (const input of [email, token]) {
      input.setAttribute("aria-invalid", String(invalidCredentials));
      input.style.borderColor = invalidCredentials ? "var(--danger,#e66)" : "";
    }
    section.setAttribute("aria-busy", String(!!busyAction));
  }
  function choose(next) {
    if (
      disposed ||
      busyAction ||
      !host.connection.connected ||
      !host.connection.canWrite ||
      !model?.person ||
      model.loginUnreadable
    )
      return;
    if ((next === "replace" || next === "disconnect") && !model.login) return;
    if (next === "connect" && model.login) return;
    mode = next;
    token.value = "";
    email.value = model.login?.user ?? "";
    invalidCredentials = false;
    error = "";
    model = { ...model, notice: undefined };
    render();
  }
  function apply(next) {
    model = next;
    scopes.replaceChildren(
      ...(next.requiredScopes ?? []).map((s) =>
        node("li", {}, node("code", { textContent: s })),
      ),
    );
    if (!next.login && ["replace", "disconnect"].includes(mode))
      mode = "overview";
  }
  async function invoke(action, params = {}) {
    if (
      disposed ||
      busyAction ||
      !host.connection.connected ||
      !host.connection.canRead ||
      (action !== "get" && !host.connection.canWrite)
    )
      return;
    const epoch = generation;
    let openingCheck = false;
    busyAction = action;
    invalidCredentials = false;
    error = "";
    if (action === "check") {
      checkState = "pending";
      checkAttemptedAt = new Date().toISOString();
    }
    if (model) model = { ...model, notice: undefined };
    render();
    try {
      const next = await host.request(method(action), params);
      if (disposed || epoch !== generation) return;
      invalidCredentials = action === "connect" && next.status === 400;
      apply(next);
      if (action === "get" && checkOnOpen) {
        checkOnOpen = false;
        openingCheck =
          !!next.login &&
          !!next.person &&
          !next.loginUnreadable &&
          host.connection.canWrite;
        if (openingCheck) checkState = "pending";
      }
      if (action === "check") {
        checkState = next.status < 400 ? "fresh" : "failed";
        checkMessage = next.notice?.ok === false ? next.notice.text : "";
      }
      if (
        (action === "connect" || action === "disconnect") &&
        next.notice?.ok
      ) {
        mode = "overview";
        checkState = action === "connect" ? "fresh" : "idle";
        token.value = "";
        email.value = next.login?.user ?? "";
      }
    } catch {
      if (!disposed && epoch === generation) {
        error =
          "The Bitbucket request failed. Check your OpenClaw connection and try again.";
        if (action === "check") {
          checkState = "failed";
          checkMessage = error;
        }
      }
    } finally {
      if (!disposed && epoch === generation) {
        busyAction = null;
        render();
        if (openingCheck) void invoke("check");
      }
    }
  }
  form.onsubmit = (event) => {
    event.preventDefault();
    if (
      !["connect", "replace"].includes(mode) ||
      busyAction ||
      !host.connection.canWrite
    )
      return;
    const params = { user: email.value, token: token.value };
    token.value = "";
    void invoke("connect", params);
  };
  const refresh = () => {
    const key = `${host.connection.connected}:${host.connection.canRead}:${host.connection.canWrite}`;
    if (key === signature) return;
    signature = key;
    generation++;
    busyAction = null;
    model = undefined;
    mode = "overview";
    checkState = "idle";
    checkMessage = "";
    checkAttemptedAt = undefined;
    checkOnOpen = true;
    extraExpanded = false;
    invalidCredentials = false;
    token.value = "";
    email.value = "";
    error = "";
    render();
    if (host.connection.connected && host.connection.canRead)
      void invoke("get");
  };
  const stop = host.subscribe(refresh);
  refresh();
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
