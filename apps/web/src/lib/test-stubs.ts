// Bun's `mock.module` is process-wide, and the first mock of a module fixes
// its export names for every test file after it. A module that more than one
// test mocks is stubbed here once, with every name any of them needs.

import { DEFAULT_USER_SETTINGS } from "@revv/shared";

export const tokenStub = () => ({
  getToken: () => "t",
  authHeaders: () => ({ Authorization: "Bearer t" }),
});

export const settingsStub = () => ({
  getSettings: () => DEFAULT_USER_SETTINGS,
  getGithubHost: () => DEFAULT_USER_SETTINGS.githubHost,
  isSettingsLoaded: () => false,
});

/** `prs.svelte`: each test overrides the names it drives. */
export const prsStub = (overrides: Record<string, (...args: never[]) => unknown> = {}) => ({
  getPrById: (_id: string): unknown => undefined,
  rereadLists: (): void => {},
  ...overrides,
});
