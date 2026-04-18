import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { RatingAxis } from "@revv/shared";

// ── Types ────────────────────────────────────────────────────────────────────

export interface OpencodeInitialState {
	blockCount: number;
	issueCount: number;
	summarySet: boolean;
	ratedAxes: RatingAxis[];
}

// ── Path resolution ──────────────────────────────────────────────────────────

/** Path to the stdio server entry point. In dev, run directly via `bun run`. */
export function getStdioServerPath(): string {
	const url = new URL("./walkthrough-stdio-server.ts", import.meta.url);
	return url.pathname;
}

// ── Config builder ───────────────────────────────────────────────────────────

/** Build the opencode.jsonc config content as a JSON string. */
export function buildOpencodeConfig(params: {
	stdioServerPath: string;
	initialState?: OpencodeInitialState;
	model?: string;
}): string {
	const env: Record<string, string> = {};
	if (params.initialState) {
		env["REVV_WT_BLOCK_COUNT"] = String(params.initialState.blockCount);
		env["REVV_WT_ISSUE_COUNT"] = String(params.initialState.issueCount);
		env["REVV_WT_SUMMARY_SET"] = String(params.initialState.summarySet);
		env["REVV_WT_RATED_AXES"] = JSON.stringify(params.initialState.ratedAxes);
	}

	const config: Record<string, unknown> = {
		$schema: "https://opencode.ai/config.schema.json",
		mcp: {
			"revv-walkthrough": {
				type: "local",
				command: ["bun", "run", params.stdioServerPath],
				...(Object.keys(env).length > 0 ? { environment: env } : {}),
			},
		},
	};
	return JSON.stringify(config, null, 2);
}

// ── Scoped config writer ─────────────────────────────────────────────────────

/**
 * Write opencode.jsonc into `dir`, run `fn`, then remove the config file.
 * Cleanup always runs even if `fn` throws.
 */
export async function withTempOpencodeConfig<T>(
	dir: string,
	configContent: string,
	fn: () => Promise<T>,
): Promise<T> {
	const configPath = join(dir, "opencode.jsonc");
	await writeFile(configPath, configContent, "utf8");
	try {
		return await fn();
	} finally {
		await rm(configPath, { force: true });
	}
}
