<script lang="ts">
import ArrowLeftRight from "phosphor-svelte/lib/ArrowsHorizontal";
import ImageOff from "phosphor-svelte/lib/ImageBroken";
import { onDestroy } from "svelte";
import { API_BASE_URL } from "$lib/api/base-url";
import { Dotmatrix } from "$lib/components/ui/dotmatrix";
import type { ReviewFile } from "$lib/types/review";
import { authHeaders } from "$lib/utils/session-token";

interface Props {
  prId: string;
  file: ReviewFile;
}

let { prId, file }: Props = $props();

interface SidePane {
  url: string | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
  error: string | null;
  loading: boolean;
}

const blank: SidePane = {
  url: null,
  width: null,
  height: null,
  bytes: null,
  error: null,
  loading: false,
};

let baseSide = $state<SidePane>({ ...blank });
let headSide = $state<SidePane>({ ...blank });

// Track every object URL we mint so onDestroy can revoke them. Without
// this each PR diff visit would leak a blob URL per image until the tab
// closes.
const createdUrls: string[] = [];

const showBase = $derived(!file.isNew);
const showHead = $derived(!file.isDeleted);
const oldPath = $derived(file.oldPath ?? file.path);

async function loadSide(path: string, side: "base" | "head"): Promise<SidePane> {
  const url = `${API_BASE_URL}/api/prs/${prId}/file-blob?path=${encodeURIComponent(path)}&side=${side}`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: authHeaders(),
      credentials: "include",
    });
  } catch (e) {
    return {
      ...blank,
      error: e instanceof Error ? e.message : "Network error",
    };
  }

  if (!response.ok) {
    let detail = `${response.status}`;
    try {
      const text = await response.text();
      if (text) detail = text;
    } catch {
      // ignore — fall back to status code
    }
    return { ...blank, error: detail };
  }

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  createdUrls.push(objectUrl);
  return {
    url: objectUrl,
    width: null,
    height: null,
    bytes: blob.size,
    error: null,
    loading: false,
  };
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function releaseUrls(): void {
  for (const u of createdUrls) URL.revokeObjectURL(u);
  createdUrls.length = 0;
}

// `file.path` is the load key. When the user switches files, this $effect
// re-runs. Revoke any previously-minted object URLs first so we don't leak
// a blob per switch; the captured `path` then guards against a stale
// fetch landing after a second switch.
$effect(() => {
  const path = file.path;
  const old = oldPath;
  const wantBase = showBase;
  const wantHead = showHead;

  releaseUrls();

  if (wantBase) {
    baseSide = { ...blank, loading: true };
    loadSide(old, "base").then((result) => {
      if (file.path === path) baseSide = result;
    });
  } else {
    baseSide = { ...blank };
  }

  if (wantHead) {
    headSide = { ...blank, loading: true };
    loadSide(path, "head").then((result) => {
      if (file.path === path) headSide = result;
    });
  } else {
    headSide = { ...blank };
  }
});

onDestroy(() => {
  releaseUrls();
});

function onImgLoad(event: Event, side: "base" | "head"): void {
  const img = event.currentTarget as HTMLImageElement;
  if (side === "base") {
    baseSide = { ...baseSide, width: img.naturalWidth, height: img.naturalHeight };
  } else {
    headSide = { ...headSide, width: img.naturalWidth, height: img.naturalHeight };
  }
}
</script>

<div class="image-diff">
	{#if showBase && showHead}
		<div class="pane-wrap">
			<div class="pane">
				<div class="pane-header">
					<span class="pane-label pane-label--removed">Before</span>
					{#if baseSide.width && baseSide.height}
						<span class="pane-meta">
							{baseSide.width}×{baseSide.height} · {formatBytes(baseSide.bytes)}
						</span>
					{/if}
				</div>
				<div class="frame frame--removed">
					{#if baseSide.loading}
						<div class="placeholder"><Dotmatrix variant="square-9" size="small" /></div>
					{:else if baseSide.error}
						<div class="placeholder error">
							<ImageOff size={20} />
							<span>{baseSide.error}</span>
						</div>
					{:else if baseSide.url}
						<img
							src={baseSide.url}
							alt="Before"
							onload={(e) => onImgLoad(e, 'base')}
						/>
					{/if}
				</div>
			</div>

			<div class="arrow">
				<ArrowLeftRight size={16} />
			</div>

			<div class="pane">
				<div class="pane-header">
					<span class="pane-label pane-label--added">After</span>
					{#if headSide.width && headSide.height}
						<span class="pane-meta">
							{headSide.width}×{headSide.height} · {formatBytes(headSide.bytes)}
						</span>
					{/if}
				</div>
				<div class="frame frame--added">
					{#if headSide.loading}
						<div class="placeholder"><Dotmatrix variant="square-9" size="small" /></div>
					{:else if headSide.error}
						<div class="placeholder error">
							<ImageOff size={20} />
							<span>{headSide.error}</span>
						</div>
					{:else if headSide.url}
						<img
							src={headSide.url}
							alt="After"
							onload={(e) => onImgLoad(e, 'head')}
						/>
					{/if}
				</div>
			</div>
		</div>
	{:else if showHead}
		<div class="pane single">
			<div class="pane-header">
				<span class="pane-label pane-label--added">Added</span>
				{#if headSide.width && headSide.height}
					<span class="pane-meta">
						{headSide.width}×{headSide.height} · {formatBytes(headSide.bytes)}
					</span>
				{/if}
			</div>
			<div class="frame frame--added">
				{#if headSide.loading}
					<div class="placeholder"><Dotmatrix variant="square-9" size="small" /></div>
				{:else if headSide.error}
					<div class="placeholder error">
						<ImageOff size={20} />
						<span>{headSide.error}</span>
					</div>
				{:else if headSide.url}
					<img
						src={headSide.url}
						alt="Added"
						onload={(e) => onImgLoad(e, 'head')}
					/>
				{/if}
			</div>
		</div>
	{:else if showBase}
		<div class="pane single">
			<div class="pane-header">
				<span class="pane-label pane-label--removed">Removed</span>
				{#if baseSide.width && baseSide.height}
					<span class="pane-meta">
						{baseSide.width}×{baseSide.height} · {formatBytes(baseSide.bytes)}
					</span>
				{/if}
			</div>
			<div class="frame frame--removed">
				{#if baseSide.loading}
					<div class="placeholder"><Dotmatrix variant="square-9" size="small" /></div>
				{:else if baseSide.error}
					<div class="placeholder error">
						<ImageOff size={20} />
						<span>{baseSide.error}</span>
					</div>
				{:else if baseSide.url}
					<img
						src={baseSide.url}
						alt="Removed"
						onload={(e) => onImgLoad(e, 'base')}
					/>
				{/if}
			</div>
		</div>
	{/if}
</div>

<style>
	.image-diff {
		padding: 16px 32px 48px;
	}

	.pane-wrap {
		display: grid;
		grid-template-columns: 1fr auto 1fr;
		gap: 16px;
		align-items: start;
	}

	.pane {
		display: flex;
		flex-direction: column;
		gap: 8px;
		min-width: 0;
	}

	.pane.single {
		max-width: 720px;
		margin-inline: auto;
	}

	.pane-header {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.pane-label {
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		border-radius: 3px;
		padding: 1px 6px;
	}

	.pane-label--removed {
		background: color-mix(in srgb, var(--color-danger) 13%, transparent);
		color: var(--color-danger);
	}

	.pane-label--added {
		background: color-mix(in srgb, var(--color-success) 13%, transparent);
		color: var(--color-success);
	}

	.pane-meta {
		font-size: 11px;
		color: var(--color-text-muted);
		font-family: var(--font-mono, monospace);
	}

	.frame {
		position: relative;
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 160px;
		border-radius: 8px;
		border: 1px solid var(--color-border);
		background:
			linear-gradient(45deg, var(--color-glass-bg) 25%, transparent 25%),
			linear-gradient(-45deg, var(--color-glass-bg) 25%, transparent 25%),
			linear-gradient(45deg, transparent 75%, var(--color-glass-bg) 75%),
			linear-gradient(-45deg, transparent 75%, var(--color-glass-bg) 75%);
		background-size: 16px 16px;
		background-position:
			0 0,
			0 8px,
			8px -8px,
			-8px 0;
		overflow: hidden;
	}

	.frame--removed {
		border-color: color-mix(in srgb, var(--color-danger) 30%, var(--color-border));
	}

	.frame--added {
		border-color: color-mix(in srgb, var(--color-success) 30%, var(--color-border));
	}

	.frame img {
		max-width: 100%;
		max-height: 70vh;
		object-fit: contain;
		display: block;
	}

	.arrow {
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--color-text-muted);
		padding-top: 40px;
	}

	.placeholder {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 6px;
		padding: 32px;
		font-size: 12px;
		color: var(--color-text-muted);
	}

	.placeholder.error {
		color: var(--color-danger);
	}
</style>
