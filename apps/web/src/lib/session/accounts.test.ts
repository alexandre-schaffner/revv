import { describe, expect, test } from "bun:test";
import { type Account, reauthAsked, withIdentity, withReauth } from "./accounts";

const account = (host: string, overrides: Partial<Account> = {}): Account => ({
  host,
  githubLogin: `me-${host}`,
  avatarContent: null,
  reauthRequired: false,
  ...overrides,
});

describe("the user's accounts", () => {
  test("one account's re-auth clearing leaves another's standing", () => {
    let accounts: readonly Account[] = [account("github.com"), account("ghe.example.com")];
    accounts = withReauth(accounts, { host: "ghe.example.com", reauthRequired: true });
    accounts = withReauth(accounts, { host: "github.com", reauthRequired: true });
    accounts = withReauth(accounts, { host: "github.com", reauthRequired: false });
    expect(reauthAsked(accounts, null).blocking?.host).toBe("ghe.example.com");
  });

  test("a re-auth push for an account not read yet is kept, a clear for one is dropped", () => {
    expect(withReauth([], { host: "github.com", reauthRequired: false })).toEqual([]);
    const flagged = withReauth([], {
      host: "GHE.example.com",
      reauthRequired: true,
      githubLogin: "ada",
    });
    expect(reauthAsked(flagged, null).blocking).toEqual(
      account("GHE.example.com", { githubLogin: "ada", reauthRequired: true }),
    );
    expect(
      reauthAsked(withReauth(flagged, { host: "ghe.example.com", reauthRequired: false }), null)
        .blocking,
    ).toBeNull();
  });

  test("only the shown host's re-auth blocks; another host's waits", () => {
    const accounts = [
      account("github.com", { reauthRequired: true }),
      account("ghe.example.com", { reauthRequired: true }),
      account("ghe2.example.com"),
    ];
    expect(reauthAsked(accounts, "GHE.example.com")).toEqual({
      blocking: accounts[1] as Account,
      waiting: [accounts[0] as Account],
    });
    expect(reauthAsked(accounts, "ghe2.example.com")).toEqual({
      blocking: null,
      waiting: [accounts[0] as Account, accounts[1] as Account],
    });
  });

  test("an identity change lands on its own host, keeping the avatar shown when none came", () => {
    const accounts = [
      account("github.com", { avatarContent: "data:a" }),
      account("ghe.example.com", { avatarContent: "data:b" }),
    ];
    expect(
      withIdentity(accounts, { host: "github.com", githubLogin: "renamed", avatarContent: null }),
    ).toEqual([
      account("github.com", { githubLogin: "renamed", avatarContent: "data:a" }),
      accounts[1] as Account,
    ]);
  });
});
