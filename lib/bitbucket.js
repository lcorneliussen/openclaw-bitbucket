// The one Bitbucket call the plugin makes: whose token is this?
const API = "https://api.bitbucket.org/2.0/user";

export class BitbucketRejected extends Error {}

// Resolves to the account's display name. Throws BitbucketRejected when
// Bitbucket does not accept the e-mail and token, and a plain Error when
// Bitbucket could not be asked.
export async function verifyToken(user, token, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(API, {
      headers: {
        accept: "application/json",
        authorization: `Basic ${Buffer.from(`${user}:${token}`).toString("base64")}`,
      },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new Error(`Bitbucket could not be reached: ${error?.message ?? error}`);
  }
  if (response.status === 401 || response.status === 403) {
    throw new BitbucketRejected("Bitbucket did not accept this e-mail and token.");
  }
  if (!response.ok) throw new Error(`Bitbucket answered ${response.status}.`);
  const account = await response.json();
  return String(account.display_name || account.nickname || user);
}
