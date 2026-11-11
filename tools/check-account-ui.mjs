// Optional browser evidence: node tools/check-account-ui.mjs PLAYWRIGHT_MODULE OUTPUT_DIRECTORY
import path from "node:path";
import { pathToFileURL } from "node:url";
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
      const creationLink = page.getByRole("link", {
        name: "Create a Bitbucket API token",
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
          "Choose “Create API token with scopes”, select Bitbucket, then grant all six scopes:",
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
        path: new URL(`account-${theme}-${width}.png`, out).pathname,
        fullPage: true,
      });
      results.push({
        theme,
        width,
        overflow,
        buttonMoved: Math.abs(before.y - after.y),
        calls,
      });
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
  "Six native-form browser cases passed; credential input cleared and RPC dispatch verified",
);
