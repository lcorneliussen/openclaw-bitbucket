// Optional browser evidence: node tools/check-account-ui.mjs PLAYWRIGHT_MODULE OUTPUT_DIRECTORY
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
if (!process.argv[2] || !process.argv[3])
  throw Error("Pass a Playwright module path and output directory");
const { chromium } = await import(
  pathToFileURL(path.resolve(process.argv[2])).href
);
import fs from "node:fs/promises";
const out = pathToFileURL(path.resolve(process.argv[3]) + path.sep);
await fs.mkdir(out, { recursive: true });
const source = await fs.readFile(
  new URL("../dist/control-ui/v1/index.js", import.meta.url),
  "utf8",
);
const moduleUrl =
  "data:text/javascript;base64," + Buffer.from(source).toString("base64");
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const theme of ["dark", "light"])
    for (const width of [320, 390, 960]) {
      const page = await browser.newPage({
        viewport: { width, height: 950 },
        colorScheme: theme,
      });
      await page.route("http://account.example.invalid/", (r) =>
        r.fulfill({
          contentType: "text/html",
          body: `<!doctype html><style>:root{--bg:${theme === "dark" ? "#0f1116" : "#fff"};--text:${theme === "dark" ? "#ddd" : "#222"};--muted:#888;--border:#8886;--accent:${theme === "dark" ? "#8ab4ff" : "#2563eb"}}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 system-ui}h1{font-size:24px;margin:0 0 12px}p{margin:8px 0}</style><main id="root"></main>`,
        }),
      );
      await page.goto("http://account.example.invalid/");
      await page.evaluate(async (u) => {
        const mod = await import(u);
        window.accountModule = mod;
        window.calls = [];
        const model = {
          status: 200,
          person: "Ada Example",
          login: null,
          enabled: true,
          requiredScopes: [
            "read:user:bitbucket",
            "read:repository:bitbucket",
            "write:repository:bitbucket",
            "read:pullrequest:bitbucket",
            "write:pullrequest:bitbucket",
            "read:pipeline:bitbucket",
          ],
        };
        window.baseModel = model;
        const host = {
          connection: { connected: true, canRead: true, canWrite: true },
          subscribe: () => () => {},
          request: async (method, params) => {
            window.calls.push(method);
            return {
              ...model,
              ...(method.endsWith(".connect")
                ? {
                    status: 400,
                    notice: {
                      ok: false,
                      text: "Bitbucket rejected this token. Check the account email and token.",
                    },
                  }
                : {}),
            };
          },
        };
        window.host = host;
        host.subscribe = (fn) => ((window.notify = fn), () => {});
        window.view = mod.mountAccount(document.querySelector("#root"), {
          host,
        });
      }, moduleUrl);
      await page
        .getByRole("button", { name: "Connect Bitbucket", exact: true })
        .click();
      const creationLink = page.getByRole("link", {
        name: "Create a scoped Bitbucket API token",
      });
      if (!(await creationLink.isVisible()))
        throw Error(
          "Token creation link must be visible without expanding help",
        );
      if (
        (await creationLink.getAttribute("href")) !==
        "https://id.atlassian.com/manage-profile/security/api-tokens"
      )
        throw Error("Unexpected token management destination");
      await page
        .getByText(
          "Unscoped API tokens won’t work. Choose “Create API token with scopes”, select Bitbucket, then grant all six scopes:",
        )
        .waitFor();
      for (const scope of [
        "read:user:bitbucket",
        "read:repository:bitbucket",
        "write:repository:bitbucket",
        "read:pullrequest:bitbucket",
        "write:pullrequest:bitbucket",
        "read:pipeline:bitbucket",
      ]) {
        if (!(await page.getByText(scope, { exact: true }).isVisible()))
          throw Error("Missing visible scope: " + scope);
      }
      await page
        .getByLabel("Atlassian account email")
        .fill("ada@example.invalid");
      await page
        .getByLabel("Bitbucket API token")
        .fill("synthetic-not-a-real-token");
      const before = await page
        .getByRole("button", { name: "Connect", exact: true })
        .boundingBox();
      await page.getByRole("button", { name: "Connect", exact: true }).click();
      await page
        .getByRole("status")
        .filter({ hasText: "Bitbucket rejected" })
        .waitFor();
      if (
        (await page
          .getByLabel("Bitbucket API token")
          .getAttribute("aria-invalid")) !== "true"
      )
        throw Error("Invalid credential field not marked");
      if ((await page.getByLabel("Bitbucket API token").inputValue()) !== "")
        throw Error("Token retained");
      const after = await page
        .getByRole("button", { name: "Connect", exact: true })
        .boundingBox();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      );
      const calls = await page.evaluate(() => window.calls);
      if (Math.abs(before.y - after.y) > 1)
        throw Error("Feedback moved the action button");
      if (
        overflow ||
        calls.join(",") !==
          "bitbucket.connection.get,bitbucket.connection.connect"
      )
        throw Error("Layout or dispatch regression");
      await page.screenshot({
        path: fileURLToPath(new URL(`account-${theme}-${width}.png`, out)),
        fullPage: true,
      });
      results.push({
        theme,
        width,
        overflow,
        buttonMoved: Math.abs(before.y - after.y),
        calls,
      });
      const states = [];
      const capture = async (name) => {
        if (
          await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          )
        )
          throw Error("Overflow in " + name);
        await page.screenshot({
          path: fileURLToPath(
            new URL(`status-${name}-${theme}-${width}.png`, out),
          ),
          fullPage: true,
        });
        states.push(name);
      };
      await page.evaluate(() => {
        window.view.dispose();
        window.calls = [];
        window.saved = {
          ...window.baseModel,
          login: {
            name: "Ada Example",
            user: "ada@example.invalid",
            stored: "2026-01-01T00:00:00Z",
            scopeCheck: {
              status: "verified",
              checkedAt: "2026-01-01T00:00:00Z",
              granted: [
                ...window.baseModel.requiredScopes,
                "read:workspace:bitbucket",
                "admin:repository:bitbucket",
              ],
            },
          },
        };
        window.host.request = async (method) => {
          window.calls.push(method);
          if (method.endsWith(".check"))
            return new Promise(
              (r) =>
                (window.finishCheck = () =>
                  r({
                    ...window.saved,
                    notice: { ok: true, text: "Permission check completed." },
                  })),
            );
          if (method.endsWith(".disconnect"))
            return {
              ...window.baseModel,
              notice: { ok: true, text: "Disconnected." },
            };
          return window.saved;
        };
        window.view = window.accountModule.mountAccount(
          document.querySelector("#root"),
          { host: window.host },
        );
      });
      await page.getByRole("status").filter({ hasText: "Checking…" }).waitFor();
      if (await page.locator("form").isVisible())
        throw Error("Opening exposed replacement form");
      await capture("checking");
      await page.evaluate(() => window.finishCheck());
      await page
        .getByRole("status")
        .filter({ hasText: /^Connected$/ })
        .waitFor();
      await page.evaluate(() => {
        window.notify();
        window.notify();
      });
      if (
        (await page.evaluate(() => window.calls)).join(",") !==
        "bitbucket.connection.get,bitbucket.connection.check"
      )
        throw Error("Opening check looped");
      const columns = await page.evaluate(() => {
        const labels = [...document.querySelectorAll("span")];
        const account = labels.find((n) => n.textContent === "Account"),
          token = labels.find((n) => n.textContent === "Token");
        const a = account.getBoundingClientRect(),
          t = token.getBoundingClientRect(),
          av = account.nextElementSibling.getBoundingClientRect(),
          tv = token.nextElementSibling.getBoundingClientRect();
        return Math.max(Math.abs(a.x - t.x), Math.abs(av.x - tv.x));
      });
      if (columns > 1) throw Error("Account and token columns are misaligned");
      results.at(-1).columnAlignmentError = columns;
      const scopeRows = page.locator("li[aria-label]");
      if ((await scopeRows.count()) !== 8)
        throw Error("Expected six required and two additional grants");
      for (const scope of [
        ...(await page.evaluate(() => window.baseModel.requiredScopes)),
        "read:workspace:bitbucket",
        "admin:repository:bitbucket",
      ]) {
        const row = page
          .locator("li")
          .filter({ has: page.locator(`[title="${scope}"]`) });
        if (!(await row.getAttribute("aria-label")).endsWith(": Granted"))
          throw Error("Granted scope not shown individually");
      }
      await capture("connected");
      await page
        .getByRole("button", { name: "Replace token…", exact: true })
        .click();
      if (!(await creationLink.isVisible()))
        throw Error("Replacement guidance hidden");
      await capture("replace");
      await page.getByLabel("Bitbucket API token").fill("synthetic-cancelled");
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      if (
        (await page.locator("form").isVisible()) ||
        (await page.getByLabel("Bitbucket API token").inputValue())
      )
        throw Error("Replacement cancel failed");
      await page
        .getByRole("button", { name: "Disconnect…", exact: true })
        .click();
      await capture("disconnect");
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      if (
        (await page.evaluate(() => window.calls)).some((m) =>
          m.endsWith(".disconnect"),
        )
      )
        throw Error("Disconnect cancelled too late");
      await page
        .getByRole("button", { name: "Disconnect…", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Disconnect Bitbucket", exact: true })
        .click();
      await page
        .getByRole("status")
        .filter({ hasText: /^Not connected$/ })
        .waitFor();
      await capture("disconnected");
      await page.evaluate(() => {
        window.view.dispose();
        window.calls = [];
        window.host.request = async (method) => {
          window.calls.push(method);
          return method.endsWith(".check")
            ? {
                ...window.saved,
                status: 502,
                notice: {
                  ok: false,
                  text: "Bitbucket could not be reached. The saved token was kept.",
                },
              }
            : window.saved;
        };
        window.view = window.accountModule.mountAccount(
          document.querySelector("#root"),
          { host: window.host },
        );
      });
      await page
        .getByRole("status")
        .filter({ hasText: /^Needs attention$/ })
        .waitFor();
      if (
        await page
          .getByRole("status")
          .filter({ hasText: /^Connected$/ })
          .count()
      )
        throw Error("Stale verification shown as connected");
      await capture("check-failed");
      for (const variant of ["missing", "unknown"]) {
        await page.evaluate((variant) => {
          window.view.dispose();
          window.host.connection.canWrite = false;
          const model = {
            ...window.saved,
            login: {
              ...window.saved.login,
              scopeCheck: {
                status: variant,
                checkedAt: "2026-01-01T00:00:00Z",
                ...(variant === "missing"
                  ? {
                      granted: [
                        "read:user:bitbucket",
                        "read:workspace:bitbucket",
                      ],
                    }
                  : {}),
              },
            },
          };
          window.host.request = async () => model;
          window.view = window.accountModule.mountAccount(
            document.querySelector("#root"),
            { host: window.host },
          );
        }, variant);
        await page
          .getByRole("status")
          .filter({
            hasText:
              variant === "missing"
                ? /^Missing scopes \(saved\)$/
                : /^Token saved$/,
          })
          .waitFor();
        const states = await page
          .locator("li[aria-label]")
          .evaluateAll((rows) => rows.map((r) => r.getAttribute("aria-label")));
        if (
          variant === "unknown" &&
          (states.length !== 6 || states.some((s) => !s.endsWith(": Unknown")))
        )
          throw Error("Unreported scopes inferred as grants");
        if (
          variant === "missing" &&
          states.filter((s) => s.includes(": Missing")).length !== 5
        )
          throw Error("Missing scopes not identified");
        await capture("saved-" + variant);
      }
      results.at(-1).states = states;
      await page.evaluate(() => {
        window.host.connection.connected = false;
        window.notify();
      });
      if (await page.locator("form").isVisible())
        throw Error("Disconnected form remained visible");
      await page.close();
    }
} finally {
  await browser.close();
}
await fs.writeFile(
  new URL("results.json", out),
  JSON.stringify(results, null, 2),
);
console.log(
  "Six browser cases passed across nine account states; checks, explicit editing and disconnect confirmation verified",
);
