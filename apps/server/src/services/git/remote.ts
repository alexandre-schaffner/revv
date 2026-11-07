// How Revv authenticates to a GitHub remote. The token travels in the URL of
// each fetch/push, so it never lands in `.git/config`; a clone carries it in
// a header instead, because `git clone` records its URL as `origin`.
//
// GitHub hosts take the token as the password of the `x-access-token` user.
// `redactGitAuth` is written against exactly that shape.

import { Buffer } from "node:buffer";

export interface RemoteAuth {
  /** `github.com`, or a GitHub Enterprise host. */
  readonly host: string;
  /** `owner/name`. */
  readonly fullName: string;
  readonly token: string;
}

/** The repository's HTTPS URL with the token in it, for one fetch or push. */
export function authedRemoteUrl({ host, fullName, token }: RemoteAuth): string {
  return `https://x-access-token:${token}@${host}/${fullName}.git`;
}

/** The token-free URL a clone records as `origin`, plus the `-c` flag that authenticates it. */
export function cloneSource({ host, fullName, token }: RemoteAuth): {
  readonly url: string;
  readonly authConfig: readonly string[];
} {
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    url: `https://${host}/${fullName}.git`,
    authConfig: ["-c", `http.extraHeader=Authorization: Basic ${basic}`],
  };
}

/** Strip the token out of anything git echoed back (`fatal: unable to access '<url>'`). */
export function redactGitAuth(message: string): string {
  return message.replace(/x-access-token:[^@\s]+@/g, "x-access-token:<redacted>@");
}
