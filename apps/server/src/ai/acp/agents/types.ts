import type { AgentStatus, ThinkingEffort } from "@revv/shared";

export type AgentAuthStatus = Pick<
  AgentStatus,
  "authed" | "verified" | "authSource" | "authLabel" | "authWarning"
>;

/** The Revv selections pushed into an agent at launch; absent fields leave its default. */
export interface LaunchSelection {
  readonly model?: string | undefined;
  readonly thinkingEffort?: ThinkingEffort | undefined;
}

export interface LaunchRouting {
  readonly env: Record<string, string>;
  /**
   * A model applied to every session the connection opens or loads, through
   * the session's `model` config option, for agents that ignore a launch-time one.
   */
  readonly sessionModel?: string;
}

/**
 * Which process the environment is for: the ACP subprocess, the CLI's auth
 * status probe, or the interactive login PTY. They must agree on anything that
 * scopes the agent's credentials (Claude's config dir).
 */
export type AgentProcessPurpose = "acp" | "status" | "login";

export interface AgentModelOption {
  readonly label: string;
  readonly value: string;
}

/**
 * Every server-side fact about one ACP agent that is behaviour rather than
 * registry data (that lives in `@revv/shared`'s `ACP_AGENTS`).
 */
export interface AgentAdapter {
  readonly route: (selection: LaunchSelection) => LaunchRouting;
  /** Starts from the host env (inherited, PATH widened); may prepare on-disk state. */
  readonly processEnv: (
    env: Record<string, string>,
    purpose: AgentProcessPurpose,
  ) => Record<string, string>;
  /** The vendor CLI's absolute path (pin, PATH, known install dirs), or null. */
  readonly resolveBin: () => string | null;
  /**
   * The ACP adapter shells out to the vendor CLI, so launching needs it. The
   * others run a self-contained adapter and need the CLI only to sign in.
   */
  readonly launchNeedsCli: boolean;
  /** Credentials the adapter can use without the CLI installed (an auth file, an API key). */
  readonly hasCredentialsWithoutCli: () => boolean;
  readonly authStatus: () => AgentAuthStatus;
  /** The ACP auth method to request from those the agent advertises. */
  readonly authMethod: (methods: readonly { readonly id: string }[]) => string | undefined;
  readonly listModels: () => Promise<AgentModelOption[]>;
}

export const NOT_SIGNED_IN: AgentAuthStatus = {
  authed: false,
  verified: false,
  authSource: "none",
  authLabel: "Not signed in",
  authWarning: null,
};

export const firstAuthMethod: AgentAdapter["authMethod"] = (methods) => methods[0]?.id;
