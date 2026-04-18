import { execSync } from 'node:child_process';
import { CLI_CACHE_TTL_MS } from '../../constants';

// ── CLI agent detection (cached) ─────────────────────────────────────────────

let cachedCliAuth: { result: boolean; expiresAt: number; agent: string } | null = null;

function isCliAgentAvailable(agent: 'opencode' | 'claude'): boolean {
	try {
		const result = execSync(`which ${agent}`, { encoding: 'utf-8', timeout: 3000 });
		return result.trim().length > 0;
	} catch {
		return false;
	}
}

export function checkCliAvailability(agent: 'opencode' | 'claude'): boolean {
	if (cachedCliAuth && Date.now() < cachedCliAuth.expiresAt && cachedCliAuth.agent === agent) {
		return cachedCliAuth.result;
	}

	const available = isCliAgentAvailable(agent);
	cachedCliAuth = { result: available, expiresAt: Date.now() + CLI_CACHE_TTL_MS, agent };
	return available;
}

// ── Dynamic model listing ─────────────────────────────────────────────────────

export type CliModelOption = { label: string; value: string };

/**
 * List models available to the selected CLI agent.
 * For opencode: runs `opencode models --verbose` and parses output.
 * For claude: returns a hardcoded list (no offline model listing available).
 */
export async function listCliModels(agent: 'opencode' | 'claude'): Promise<CliModelOption[]> {
	if (agent === 'claude') {
		return [
			{ label: 'Claude Opus 4.7', value: 'claude-opus-4-7' },
			{ label: 'Claude Sonnet 4.6', value: 'claude-sonnet-4-6' },
			{ label: 'Claude Haiku 4.5', value: 'claude-haiku-4-5-20251001' },
		];
	}

	// opencode: run `opencode models --verbose` and parse interleaved output
	// Format: line with "provider/id", then JSON blob with model metadata, repeated
	try {
		const proc = Bun.spawn(['opencode', 'models', '--verbose'], {
			stdout: 'pipe',
			stderr: 'pipe',
		});
		const text = await new Response(proc.stdout).text();
		await proc.exited;

		const models: CliModelOption[] = [];
		const lines = text.split('\n');
		let i = 0;
		while (i < lines.length) {
			const line = lines[i]?.trim();
			if (!line) { i++; continue; }

			// Check if this line looks like a model ID (e.g. "provider/model-id")
			if (!line.startsWith('{') && line.includes('/')) {
				const modelId = line;
				// Next non-empty content should be a JSON blob — collect until balanced braces
				let jsonStr = '';
				let depth = 0;
				i++;
				while (i < lines.length) {
					const jsonLine = lines[i] ?? '';
					jsonStr += jsonLine + '\n';
					for (const ch of jsonLine) {
						if (ch === '{') depth++;
						else if (ch === '}') depth--;
					}
					i++;
					if (depth === 0 && jsonStr.trim().startsWith('{')) break;
				}
				try {
					const meta = JSON.parse(jsonStr.trim()) as { name?: string; providerID?: string };
					const label = meta.name ?? modelId;
					models.push({ label, value: modelId });
				} catch {
					models.push({ label: modelId, value: modelId });
				}
			} else {
				i++;
			}
		}
		return models;
	} catch {
		// Fallback: empty list (frontend will show empty state)
		return [];
	}
}
