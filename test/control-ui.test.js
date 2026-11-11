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
      .filter((n) => n.tagName === "input" || n.tagName === "button")
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
