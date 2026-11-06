// ── ACP process launch ───────────────────────────────────────────────────────
//
// Turns a registry agent plus Revv's model/effort selection into the
// subprocess to spawn. Per-agent behaviour comes from the adapters
// (`agents/`); what is generic lives here: the `REVV_ACP_COMMAND` override,
// the package runner fallback, and the runtime availability gate.

import { type AcpAgentId, getAcpAgent } from "@revv/shared";
import { serverEnv } from "../../config";
import { agentAdapter, agentProcessEnv } from "./agents";
import type { LaunchSelection } from "./agents/types";
import { executableExists, resolveUserPath } from "./host";

export interface AgentProcess {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  /** Applied to every session the connection opens; see `LaunchRouting.sessionModel`. */
  readonly sessionModel?: string;
  /**
   * The agent is fetched and run by a package runner (`npx`, `bunx`, `bun x`),
   * which must be spawned outside the reviewed repo: see `package-runner-dir.ts`.
   */
  readonly viaPackageRunner: boolean;
}

/** The ACP adapter's argv: `REVV_ACP_COMMAND` when set, else the registry's. */
export function agentLaunchCommand(id: AcpAgentId): {
  readonly command: string;
  readonly args: readonly string[];
  readonly overridden: boolean;
} {
  if (serverEnv.acpCommand) {
    const args = serverEnv.acpArgs.trim().length > 0 ? serverEnv.acpArgs.trim().split(/\s+/) : [];
    return { command: serverEnv.acpCommand, args, overridden: true };
  }
  const def = getAcpAgent(id);
  // An agent launched as its own CLI runs the binary the adapter resolves
  // (pin, PATH, known install dirs), the same one onboarding detects.
  const command =
    def.command === def.cli.bin ? (agentAdapter(id).resolveBin() ?? def.command) : def.command;
  return { command, args: def.args, overridden: false };
}

function stripNpxYes(args: readonly string[]): readonly string[] {
  return args[0] === "-y" || args[0] === "--yes" ? args.slice(1) : args;
}

/** `npx` → `bunx` → `bun x`, whichever the PATH has. */
function resolvePackageRunner(
  command: string,
  args: readonly string[],
  path: string,
): { readonly command: string; readonly args: readonly string[] } {
  if (command !== "npx" || executableExists("npx", path)) return { command, args };
  const bare = stripNpxYes(args);
  if (executableExists("bunx", path)) return { command: "bunx", args: bare };
  if (executableExists("bun", path)) return { command: "bun", args: ["x", ...bare] };
  return { command, args };
}

function isPackageRunner(command: string, args: readonly string[]): boolean {
  return command === "npx" || command === "bunx" || (command === "bun" && args[0] === "x");
}

/**
 * The subprocess for an agent under a selection. `env` defaults to the
 * agent's ACP environment and must carry the PATH to resolve against. The
 * `REVV_ACP_COMMAND` override is launched as given, without model routing.
 */
export function resolveAgentProcess(
  id: AcpAgentId,
  selection: LaunchSelection,
  env: Readonly<Record<string, string>> = agentProcessEnv(id, "acp"),
): AgentProcess {
  const launch = agentLaunchCommand(id);
  const routing = launch.overridden ? { env: {} } : agentAdapter(id).route(selection);
  const path = env.PATH ?? "";
  const runner = resolvePackageRunner(launch.command, launch.args, path);
  return {
    command: runner.command,
    args: runner.args,
    env: { ...env, ...routing.env, PATH: path },
    ...(routing.sessionModel ? { sessionModel: routing.sessionModel } : {}),
    viaPackageRunner: isPackageRunner(runner.command, runner.args),
  };
}

/**
 * The runtime gate: the ACP launch command resolves (`npx` counts when `bunx`
 * or `bun` can stand in), and so does the vendor CLI when the adapter shells
 * out to it. Signing in is the agent's to check, at connect.
 */
export function isAgentLaunchable(id: AcpAgentId): boolean {
  const { command, overridden } = agentLaunchCommand(id);
  const path = resolveUserPath();
  const has = (bin: string): boolean => executableExists(bin, path);
  const commandResolves =
    command === "npx"
      ? has("npx") || has("bunx") || has("bun")
      : command === "bunx"
        ? has("bunx") || has("bun")
        : has(command);
  if (!commandResolves) return false;
  return overridden || !agentAdapter(id).launchNeedsCli || agentAdapter(id).resolveBin() !== null;
}
