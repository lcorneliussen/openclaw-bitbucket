import { test } from "node:test";
import assert from "node:assert/strict";
import plugin, { mountAccount } from "../dist/control-ui/v1/index.js";
class Node {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.style = {};
    this.value = "";
    this.attrs = {};
  }
  append(...kids) {
    this.children.push(...kids);
  }
  replaceChildren(...kids) {
    this.children = kids;
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  *all() {
    yield this;
    for (const c of this.children) if (c instanceof Node) yield* c.all();
  }
}
globalThis.document = { createElement: (tag) => new Node(tag) };
const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
const state = {
  status: 200,
  person: "Ada",
  login: null,
  requiredScopes: ["read:user:bitbucket"],
  enabled: true,
};
const setup = (canWrite = true) => {
  const listeners = new Set(),
    calls = [];
  const host = {
    connection: { connected: true, canRead: true, canWrite },
    subscribe: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    request: async (method, params) => {
      calls.push({ method, params });
      return state;
    },
  };
  return { host, calls, notify: () => listeners.forEach((fn) => fn()) };
};

test("native form sends the token over authenticated RPC once, then clears it", async () => {
  const { host, calls } = setup();
  const root = new Node("root");
  const view = mountAccount(root, { host });
  await settle();
  [...root.all()]
    .find(
      (n) => n.tagName === "button" && n.textContent === "Connect Bitbucket",
    )
    .onclick();
  const form = [...root.all()].find((n) => n.tagName === "form"),
    email = [...root.all()].find((n) => n.name === "user"),
    token = [...root.all()].find((n) => n.name === "token");
  email.value = "ada@example.invalid";
  token.value = "synthetic-token";
  let complete;
  host.request = (method, params) => {
    calls.push({ method, params });
    return new Promise((r) => {
      complete = r;
    });
  };
  form.onsubmit({ preventDefault() {} });
  assert.equal(token.value, "");
  assert.deepEqual(calls.at(-1), {
    method: "bitbucket.connection.connect",
    params: { user: "ada@example.invalid", token: "synthetic-token" },
  });
  form.onsubmit({ preventDefault() {} });
  assert.equal(calls.filter((c) => c.method.endsWith("connect")).length, 1);
  complete({
    ...state,
    notice: { ok: false, text: "Bitbucket rejected the token." },
  });
  await settle();
  assert.ok(
    [...root.all()].some(
      (n) => n.textContent === "Bitbucket rejected the token.",
    ),
  );
  view.dispose();
  assert.equal(token.value, "");
  assert.equal(root.children.length, 0);
});

test("read-only UI never dispatches a credential change, even via a synthetic submit", async () => {
  const { host, calls } = setup(false),
    root = new Node("root");
  const view = mountAccount(root, { host });
  await settle();
  const form = [...root.all()].find((n) => n.tagName === "form");
  form.onsubmit({ preventDefault() {} });
  await settle();
  assert.deepEqual(
    calls.map((c) => c.method),
    ["bitbucket.connection.get"],
  );
  assert.ok(
    [...root.all()]
      .filter(
        (n) =>
          n.tagName === "input" ||
          (n.tagName === "button" &&
            n.textContent !== "Refresh status" &&
            n.attrs["aria-controls"] !== "bitbucket-extra-grants"),
      )
      .every((n) => n.disabled),
  );
  view.dispose();
});

test("connection changes clear token input and reject an old in-flight result", async () => {
  const { host, notify } = setup(),
    root = new Node("root");
  let complete;
  host.request = () =>
    new Promise((r) => {
      complete = r;
    });
  const view = mountAccount(root, { host }),
    token = [...root.all()].find((n) => n.name === "token");
  token.value = "not-retained";
  host.connection.connected = false;
  notify();
  assert.equal(token.value, "");
  complete({ ...state, person: "Old identity" });
  await settle();
  assert.equal(
    [...root.all()].some((n) => String(n.textContent).includes("Old identity")),
    false,
  );
  view.dispose();
});

test("native navigation respects the configured visibility and removes contributions", async () => {
  for (const enabled of [true, false]) {
    const { host } = setup();
    const pages = [],
      nav = [];
    let removed = 0;
    host.request = async () => ({ ...state, enabled });
    host.ui = {
      registerPage: (p) => (pages.push(p), () => removed++),
      registerNavigation: (n) => (nav.push(n), () => removed++),
    };
    const stop = plugin.activate(host);
    await settle();
    assert.equal(pages[0].id, "account");
    assert.equal(nav.length, enabled ? 1 : 0);
    stop();
    assert.equal(removed, enabled ? 2 : 1);
  }
});

test("a transient startup probe retries without retrying credentials and cancels on disposal", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { host } = setup();
  let requests = 0,
    nav = 0;
  host.ui = {
    registerPage: () => () => {},
    registerNavigation: () => {
      nav++;
      return () => {};
    },
  };
  host.request = async () => {
    if (++requests === 1) throw Error("temporary");
    return state;
  };
  const stop = plugin.activate(host);
  await settle();
  assert.equal(nav, 0);
  t.mock.timers.tick(250);
  await settle();
  assert.equal(requests, 2);
  assert.equal(nav, 1);
  stop();
  const second = setup();
  let cancelledRequests = 0;
  second.host.ui = host.ui;
  second.host.request = async () => {
    cancelledRequests++;
    throw Error("temporary");
  };
  const close = plugin.activate(second.host);
  await settle();
  close();
  t.mock.timers.tick(2000);
  await settle();
  assert.equal(cancelledRequests, 1);
});

const find = (root, tag, text) =>
  [...root.all()].find(
    (n) => n.tagName === tag && (text === undefined || n.textContent === text),
  );
const hasText = (root, text) =>
  [...root.all()].some((n) => n.textContent === text);
const saved = {
  ...state,
  login: {
    user: "ada@example.invalid",
    name: "Ada Example",
    stored: "2026-01-01T00:00:00Z",
    scopeCheck: {
      status: "verified",
      checkedAt: "2026-01-01T00:00:00Z",
      granted: state.requiredScopes,
    },
  },
};

test("opening a saved connection checks once and keeps editing explicit", async () => {
  const { host, calls, notify } = setup();
  let finish;
  host.request = async (method, params) => {
    calls.push({ method, params });
    if (method.endsWith(".check")) return new Promise((r) => (finish = r));
    return saved;
  };
  const root = new Node("root"),
    view = mountAccount(root, { host });
  await settle();
  assert.deepEqual(
    calls.map((c) => c.method),
    ["bitbucket.connection.get", "bitbucket.connection.check"],
  );
  assert.ok(hasText(root, "Checking…"));
  assert.equal(find(root, "form").hidden, true);
  notify();
  notify();
  await settle();
  assert.equal(calls.length, 2);
  finish({
    ...saved,
    notice: { ok: true, text: "Permission check completed." },
  });
  await settle();
  assert.ok(hasText(root, "Connected"));
  assert.ok(hasText(root, "Saved on gateway"));
  find(root, "button", "Replace token…").onclick();
  assert.equal(find(root, "form").hidden, false);
  assert.ok(hasText(root, "Replace token"));
  find(root, "input").value = "changed@example.invalid";
  [...root.all()].find((n) => n.name === "token").value = "synthetic-not-kept";
  const form = find(root, "form");
  find(form, "button", "Cancel").onclick();
  assert.equal(form.hidden, true);
  assert.equal([...root.all()].find((n) => n.name === "token").value, "");
  assert.equal(calls.length, 2);
  view.dispose();
});

test("read-only opening shows token presence without calling the check mutation", async () => {
  const { host, calls } = setup(false);
  host.request = async (method, params) => {
    calls.push({ method, params });
    return saved;
  };
  const root = new Node("root"),
    view = mountAccount(root, { host });
  await settle();
  assert.deepEqual(
    calls.map((c) => c.method),
    ["bitbucket.connection.get"],
  );
  assert.ok(hasText(root, "Token saved"));
  assert.equal(hasText(root, "Connected"), false);
  assert.equal(find(root, "form").hidden, true);
  find(root, "button", "Refresh status").onclick();
  await settle();
  assert.deepEqual(
    calls.map((c) => c.method),
    ["bitbucket.connection.get", "bitbucket.connection.get"],
  );
  view.dispose();
});

test("read-only status preserves saved negative permission outcomes as saved results", async () => {
  for (const outcome of ["missing", "rejected"]) {
    const { host, calls } = setup(false);
    host.request = async (method, params) => {
      calls.push({ method, params });
      return {
        ...saved,
        login: {
          ...saved.login,
          scopeCheck: {
            status: outcome,
            checkedAt: "2026-01-01T00:00:00Z",
            ...(outcome === "missing" ? { granted: [] } : {}),
          },
        },
      };
    };
    const root = new Node("root"),
      view = mountAccount(root, { host });
    await settle();
    assert.ok(
      hasText(
        root,
        outcome === "missing"
          ? "Missing scopes (saved)"
          : "Token rejected (saved)",
      ),
    );
    assert.ok(
      hasText(
        root,
        outcome === "missing"
          ? "Required scopes were missing at the last saved check."
          : "Bitbucket rejected this token at the last saved check.",
      ),
    );
    assert.equal(hasText(root, "Connected"), false);
    assert.deepEqual(
      calls.map((c) => c.method),
      ["bitbucket.connection.get"],
    );
    view.dispose();
  }
});

test("a failed opening check does not show stale verification as connected", async () => {
  const { host } = setup();
  host.request = async (method) =>
    method.endsWith(".check")
      ? {
          ...saved,
          status: 502,
          notice: { ok: false, text: "Bitbucket is unavailable." },
        }
      : saved;
  const root = new Node("root"),
    view = mountAccount(root, { host });
  await settle();
  assert.ok(hasText(root, "Needs attention"));
  assert.ok(hasText(root, "Bitbucket is unavailable."));
  const labels = [...root.all()]
    .map((n) => n.textContent)
    .filter((t) => typeof t === "string");
  assert.equal(labels.filter((t) => t === "Last attempt").length, 1);
  const savedTime = new Date(saved.login.scopeCheck.checkedAt).toLocaleString(
    undefined,
    { dateStyle: "short", timeStyle: "short" },
  );
  assert.equal(labels.includes(savedTime), false);
  assert.equal(
    labels.some((t) => t === "Last checked" || t === "Saved check"),
    false,
  );
  assert.equal(hasText(root, "Connected"), false);
  assert.ok(hasText(root, "Saved on gateway"));
  view.dispose();
});

test("disconnect requires entering its mode and explicit confirmation", async () => {
  const { host, calls } = setup();
  host.request = async (method, params) => {
    calls.push({ method, params });
    return method.endsWith(".disconnect")
      ? { ...state, notice: { ok: true, text: "Disconnected." } }
      : saved;
  };
  const root = new Node("root"),
    view = mountAccount(root, { host });
  await settle();
  find(root, "button", "Disconnect Bitbucket").onclick();
  await settle();
  assert.equal(
    calls.some((c) => c.method.endsWith(".disconnect")),
    false,
  );
  find(root, "button", "Disconnect…").onclick();
  const panel = [...root.all()].find((n) =>
    n.children?.some((c) => c?.textContent === "Disconnect Bitbucket?"),
  );
  assert.equal(panel.hidden, false);
  find(panel, "button", "Cancel").onclick();
  assert.equal(panel.hidden, true);
  assert.equal(
    calls.some((c) => c.method.endsWith(".disconnect")),
    false,
  );
  find(root, "button", "Disconnect…").onclick();
  find(root, "button", "Disconnect Bitbucket").onclick();
  await settle();
  assert.equal(calls.filter((c) => c.method.endsWith(".disconnect")).length, 1);
  assert.ok(hasText(root, "Not connected"));
  assert.equal(find(root, "form").hidden, true);
  view.dispose();
});

test("a failed disconnect stays in confirmation and displays its error", async () => {
  const { host } = setup();
  host.request = async (method) =>
    method.endsWith(".disconnect")
      ? {
          ...saved,
          status: 502,
          notice: { ok: false, text: "The saved login could not be removed." },
        }
      : saved;
  const root = new Node("root"),
    view = mountAccount(root, { host });
  await settle();
  find(root, "button", "Disconnect…").onclick();
  find(root, "button", "Disconnect Bitbucket").onclick();
  await settle();
  assert.ok(hasText(root, "The saved login could not be removed."));
  assert.equal(find(root, "button", "Disconnect Bitbucket").disabled, false);
  view.dispose();
});

const permissionRows = (root) =>
  [...root.all()].filter((n) => n.tagName === "li" && n.attrs["aria-label"]);

test("permission rows identify granted, missing and additional reported scopes", async () => {
  const { host } = setup(false),
    required = [
      "read:user:bitbucket",
      "write:repository:bitbucket",
      "read:pipeline:bitbucket",
    ];
  host.request = async () => ({
    ...saved,
    requiredScopes: required,
    login: {
      ...saved.login,
      scopeCheck: {
        status: "missing",
        checkedAt: "2026-01-01T00:00:00Z",
        granted: ["read:user:bitbucket", "read:workspace:bitbucket"],
      },
    },
  });
  const root = new Node("root"),
    view = mountAccount(root, { host });
  await settle();
  const rows = permissionRows(root);
  assert.equal(rows.length, 4);
  for (const [scope, symbol, meaning] of [
    ["read:user:bitbucket", "✓", "Granted"],
    ["write:repository:bitbucket", "×", "Missing"],
    ["read:pipeline:bitbucket", "×", "Missing"],
    ["read:workspace:bitbucket", "✓", "Granted"],
  ]) {
    const row = rows.find((n) => n.attrs["aria-label"].startsWith(scope + ":"));
    assert.ok(row);
    assert.equal(row.children[0].textContent, symbol);
    assert.match(row.attrs["aria-label"], new RegExp(meaning));
    assert.match(row.attrs["aria-label"], /saved result/);
  }
  assert.ok(hasText(root, "Not required by this plugin."));
  assert.ok(hasText(root, "Saved permission results"));
  view.dispose();
});

test("unreported grants stay unknown instead of becoming missing or extra permissions", async () => {
  const { host } = setup();
  host.request = async () => ({
    ...saved,
    login: {
      ...saved.login,
      scopeCheck: { status: "unknown", checkedAt: "2026-01-01T00:00:00Z" },
    },
  });
  const root = new Node("root"),
    view = mountAccount(root, { host });
  await settle();
  const rows = permissionRows(root);
  assert.equal(rows.length, state.requiredScopes.length);
  assert.ok(
    rows.every(
      (n) =>
        n.children[0].textContent === "?" &&
        n.attrs["aria-label"].endsWith(": Unknown"),
    ),
  );
  assert.ok(hasText(root, "Scopes unknown"));
  assert.equal(hasText(root, "Connected"), false);
  view.dispose();
});

test("a long additional-grants list expands locally while required grants stay visible", async () => {
  const { host, calls } = setup(false),
    extra = [
      "read:workspace:bitbucket",
      "write:workspace:bitbucket",
      "read:project:bitbucket",
      "write:project:bitbucket",
      "read:snippet:bitbucket",
      "write:snippet:bitbucket",
    ];
  host.request = async (method, params) => {
    calls.push({ method, params });
    return {
      ...saved,
      login: {
        ...saved.login,
        scopeCheck: {
          ...saved.login.scopeCheck,
          granted: [...state.requiredScopes, ...extra],
        },
      },
    };
  };
  const root = new Node("root"),
    view = mountAccount(root, { host });
  await settle();
  const list = [...root.all()].find((n) => n.id === "bitbucket-extra-grants"),
    toggle = find(root, "button", "Show all");
  assert.equal(list.hidden, true);
  assert.equal(toggle.attrs["aria-expanded"], "false");
  assert.ok(hasText(root, "Additional grants (6)"));
  toggle.onclick();
  assert.equal(list.hidden, false);
  assert.equal(toggle.attrs["aria-expanded"], "true");
  assert.equal(toggle.textContent, "Hide");
  assert.equal(list.children.length, 6);
  assert.ok(list.children.every((n) => n.children[0].textContent === "✓"));
  toggle.onclick();
  assert.equal(list.hidden, true);
  assert.equal(calls.length, 1);
  view.dispose();
});
