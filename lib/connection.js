// Native account methods share one coordinator. Compatibility HTTP adapters
// share it only when the caller passes the same connection service.
import {
  BitbucketRejected,
  BitbucketUnavailable,
  inspectToken,
} from "./bitbucket.js";
import { scopeCheck } from "./scopes.js";
import { readLogin, removeLogin, writeLogin } from "./logins.js";

export function createConnectionService({
  stateDir,
  verify = inspectToken,
  load = readLogin,
  save = writeLogin,
  log,
}) {
  const checks = new Map();
  const sameLogin = (a, b) =>
    a?.token === b?.token && a?.user === b?.user && a?.stored === b?.stored;
  const changedLogin = {
    ok: false,
    text: "The login changed while checking. Try again.",
  };

  const snapshot = async (profile, status = 200, notice, observation) => {
    const profileId = profile?.profileId;
    const person = profileId ? profile.displayName || profileId : undefined;
    let login,
      loginUnreadable = false;
    try {
      login = profileId ? await load(stateDir, profileId) : undefined;
    } catch {
      log?.warn?.("bitbucket: could not read the saved login");
      loginUnreadable = true;
      if (status === 200) status = 502;
    }
    // A page reload can itself outlast Disconnect or credential replacement.
    if (
      observation?.attempt.cancelled ||
      (observation && !loginUnreadable && !sameLogin(login, observation.login))
    ) {
      status = 409;
      notice = changedLogin;
    } else if (login && observation) {
      login = { ...login, scopeCheck: observation.check };
    }
    // Only metadata crosses into a browser. The stored token stays private.
    return {
      status,
      person,
      loginUnreadable,
      notice,
      login: login
        ? {
            user: login.user,
            name: login.name,
            stored: login.stored,
            scopeCheck: login.scopeCheck,
          }
        : null,
    };
  };
  const run = async (profile, form) => {
    const profileId = profile?.profileId;
    const page = (...args) => snapshot(profile, ...args);
    if (!profileId)
      return page(403, {
        ok: false,
        text: "Sign in to OpenClaw before managing a personal Bitbucket login.",
      });
    if (form.get("action") === "disconnect") {
      const check = checks.get(profileId);
      if (check) {
        check.cancelled = true;
        check.controller?.abort();
      }
      const closing = { cancelled: true };
      checks.set(profileId, closing);
      // A completed disconnect must outlast any credential write already
      // in flight. Pending network reads are aborted; their results are discarded.
      closing.committing = (async () => {
        await check?.committing?.catch(() => {});
        await removeLogin(stateDir, profileId);
      })();
      try {
        await closing.committing;
      } catch {
        log?.warn?.("bitbucket: could not remove the saved login");
        return await page(502, {
          ok: false,
          text: "The saved login could not be removed. Try again later.",
        });
      } finally {
        if (checks.get(profileId) === closing) checks.delete(profileId);
      }
      log?.info?.(`bitbucket: removed the login of profile ${profileId}`);
      return await page(200, {
        ok: true,
        text: "Disconnected. The token is deleted from this gateway.",
      });
    }

    const checking = form.get("action") === "check";
    if (checks.has(profileId)) {
      return await page(409, {
        ok: false,
        text: "Another Bitbucket login operation is running. Wait for it to finish.",
      });
    }
    const attempt = { cancelled: false, controller: new AbortController() };
    // Register before reading so Disconnect can invalidate the waiting attempt.
    checks.set(profileId, attempt);
    let existing, observed;
    const unchanged = async () => {
      const current = await load(stateDir, profileId);
      return !attempt.cancelled && sameLogin(current, existing);
    };
    try {
      try {
        existing = await load(stateDir, profileId);
      } catch {
        return await page(502, {
          ok: false,
          text: "The saved login could not be read; no changes were made.",
        });
      }
      if (attempt.cancelled) {
        return await page(409, {
          ok: false,
          text: "The login changed while checking. Try again.",
        });
      }
      if (checking && !existing) {
        return await page(400, {
          ok: false,
          text: "Connect Bitbucket before checking permissions.",
        });
      }
      const user = checking ? existing.user : (form.get("user") ?? "").trim();
      const token = checking
        ? existing.token
        : (form.get("token") ?? "").trim();
      if (!/^[^\s@]+@[^\s@]+$/.test(user) || !token || /\s/.test(token)) {
        return await page(400, {
          ok: false,
          text: "Enter the account e-mail and the API token.",
        });
      }
      const result = await verify(
        user,
        token,
        undefined,
        attempt.controller.signal,
      );
      const { name, scopeCheck: checked } =
        typeof result === "string"
          ? { name: result, scopeCheck: scopeCheck() }
          : result;
      observed = checked;
      if (!(await unchanged()) || attempt.cancelled) {
        return await page(409, {
          ok: false,
          text: "The login changed while checking. Try again.",
        });
      }
      const connected = {
        profile: profileId,
        user,
        name,
        token,
        stored: checking ? existing.stored : new Date().toISOString(),
        scopeCheck: checked,
      };
      attempt.committing = save(stateDir, connected);
      await attempt.committing;
      if (attempt.cancelled) {
        return await page(409, {
          ok: false,
          text: "The login changed while checking. Try again.",
        });
      }
      log?.info?.(`bitbucket: stored a login for profile ${profileId}`);
      return await page(
        200,
        {
          ok: true,
          text: checking
            ? "Permission check completed."
            : `Connected as ${name}.`,
        },
        { login: connected, check: checked, attempt },
      );
    } catch (error) {
      if (attempt.cancelled) {
        return await page(409, {
          ok: false,
          text: "The login changed while checking. Try again.",
        });
      }
      if (observed) {
        log?.warn?.(
          "bitbucket: could not save the login or permission-check result",
        );
        return await page(
          502,
          {
            ok: false,
            text: checking
              ? "Permission check completed, but its result could not be saved."
              : "The Bitbucket login could not be saved. Any previous login was kept.",
          },
          checking ? { login: existing, check: observed, attempt } : undefined,
        );
      }
      const rejected = error instanceof BitbucketRejected;
      const checked =
        checking && rejected
          ? (error.scopeCheck ??
            (error.credentialsRejected
              ? { status: "rejected", checkedAt: new Date().toISOString() }
              : undefined))
          : undefined;
      let recordingFailed = false;
      if (checked) {
        try {
          if (!(await unchanged()) || attempt.cancelled) {
            return await page(409, changedLogin);
          }
          attempt.committing = save(stateDir, {
            ...existing,
            scopeCheck: checked,
          });
          await attempt.committing;
        } catch {
          recordingFailed = true;
          log?.warn?.(
            "bitbucket: could not record the permission-check result",
          );
        }
      }
      if (attempt.cancelled) {
        return await page(409, changedLogin);
      }
      if (!rejected)
        log?.warn?.(
          `bitbucket: could not store a login: ${error?.message ?? error}`,
        );
      return await page(
        rejected
          ? 400
          : error instanceof BitbucketUnavailable
            ? error.status
            : 502,
        {
          ok: false,
          text:
            (rejected || error instanceof BitbucketUnavailable
              ? error.message
              : "Bitbucket could not be asked just now. Nothing was stored.") +
            (recordingFailed ? " This result could not be saved." : ""),
        },
        checked ? { login: existing, check: checked, attempt } : undefined,
      );
    } finally {
      if (checks.get(profileId) === attempt) checks.delete(profileId);
    }
  };
  return { snapshot, run };
}
