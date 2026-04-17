<script lang="ts">
	import {
		Root as PopoverRoot,
		Trigger as PopoverTrigger,
		Content as PopoverContent,
	} from '$lib/components/ui/popover/index.js';
	import { getSettings, updateSettings } from '$lib/stores/settings.svelte';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import Check from '@lucide/svelte/icons/check';
	import { API_BASE_URL } from '@revv/shared';
	import { authHeaders } from '$lib/utils/session-token';
	import type { AiAgent } from '@revv/shared';
	import { SvelteMap } from 'svelte/reactivity';
	import { toast } from 'svelte-sonner';

	let open = $state(false);

	let currentAgent = $derived((getSettings()?.aiAgent ?? 'opencode') as AiAgent);
	let fetchedModels = $state<{ label: string; value: string }[]>([]);
	let fetchDone = $state(false);
	let localModel = $state('');
	let currentModel = $derived(getSettings()?.aiModel ?? localModel);
	let currentLabel = $derived(
		!fetchDone
			? 'Loading...'
			: fetchedModels.length === 0
				? 'No models'
				: (fetchedModels.find((m) => m.value === currentModel)?.label ?? (currentModel || 'Select model'))
	);

	$effect(() => {
		// Capture for reactivity — re-runs when agent changes
		const _agent = currentAgent;
		void _agent;
		fetchDone = false;
		fetch(`${API_BASE_URL}/api/settings/models`, { headers: authHeaders() })
			.then((r) => {
				if (!r.ok) throw new Error(`HTTP ${r.status}`);
				return r.json();
			})
			.then((data: { models: { label: string; value: string }[] }) => {
				fetchedModels = data.models ?? [];
				fetchDone = true;
				// Auto-select first model if none is set
				if (!getSettings()?.aiModel && fetchedModels.length > 0) {
					const firstModel = fetchedModels[0]!.value;
					localModel = firstModel;
					// Try to persist — will fail silently if unauthenticated
					updateSettings({ aiModel: firstModel });
				}
			})
		.catch((err: Error) => {
			console.error('[ModelSelector] Failed to fetch models:', err);
			toast.error('Failed to load models');
			fetchedModels = [];
			fetchDone = true;
		});
	});

	function getProvider(value: string): string | null {
		const idx = value.indexOf('/');
		return idx !== -1 ? value.slice(0, idx) : null;
	}

	function formatProvider(provider: string): string {
		const known: Record<string, string> = {
			'github-copilot': 'GitHub Copilot',
			anthropic: 'Anthropic',
			openai: 'OpenAI',
			google: 'Google',
			mistral: 'Mistral',
			groq: 'Groq',
			bedrock: 'AWS Bedrock',
			azure: 'Azure',
		};
		return known[provider] ?? provider.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
	}

	type ProviderIcon = {
		path: string;
		paths?: string[];
		viewBox: string;
		color: string;
		fillRule?: 'evenodd' | 'nonzero';
	};

	function getProviderIcon(provider: string | null): ProviderIcon {
		if (!provider) return { path: '', viewBox: '0 0 24 24', color: '#6b7280' };

		const icons: Record<string, ProviderIcon> = {
			anthropic: {
				color: '#191919',
				viewBox: '0 0 24 24',
				path: 'M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z',
			},
			openai: {
				color: '#412991',
				viewBox: '0 0 24 24',
				path: 'M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z',
			},
			'github-copilot': {
				color: '#000000',
				viewBox: '0 0 24 24',
				path: 'M23.922 16.997C23.061 18.492 18.063 22.02 12 22.02 5.937 22.02.939 18.492.078 16.997A.641.641 0 0 1 0 16.741v-2.869a.883.883 0 0 1 .053-.22c.372-.935 1.347-2.292 2.605-2.656.167-.429.414-1.055.644-1.517a10.098 10.098 0 0 1-.052-1.086c0-1.331.282-2.499 1.132-3.368.397-.406.89-.717 1.474-.952C7.255 2.937 9.248 1.98 11.978 1.98c2.731 0 4.767.957 6.166 2.093.584.235 1.077.546 1.474.952.85.869 1.132 2.037 1.132 3.368 0 .368-.014.733-.052 1.086.23.462.477 1.088.644 1.517 1.258.364 2.233 1.721 2.605 2.656a.841.841 0 0 1 .053.22v2.869a.641.641 0 0 1-.078.256Zm-11.75-5.992h-.344a4.359 4.359 0 0 1-.355.508c-.77.947-1.918 1.492-3.508 1.492-1.725 0-2.989-.359-3.782-1.259a2.137 2.137 0 0 1-.085-.104L4 11.746v6.585c1.435.779 4.514 2.179 8 2.179 3.486 0 6.565-1.4 8-2.179v-6.585l-.098-.104s-.033.045-.085.104c-.793.9-2.057 1.259-3.782 1.259-1.59 0-2.738-.545-3.508-1.492a4.359 4.359 0 0 1-.355-.508Zm2.328 3.25c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1-.549 0-1-.451-1-1v-2c0-.549.451-1 1-1Zm-5 0c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1-.549 0-1-.451-1-1v-2c0-.549.451-1 1-1Zm3.313-6.185c.136 1.057.403 1.913.878 2.497.442.544 1.134.938 2.344.938 1.573 0 2.292-.337 2.657-.751.384-.435.558-1.15.558-2.361 0-1.14-.243-1.847-.705-2.319-.477-.488-1.319-.862-2.824-1.025-1.487-.161-2.192.138-2.533.529-.269.307-.437.808-.438 1.578v.021c0 .265.021.562.063.893Zm-1.626 0c.042-.331.063-.628.063-.894v-.02c-.001-.77-.169-1.271-.438-1.578-.341-.391-1.046-.69-2.533-.529-1.505.163-2.347.537-2.824 1.025-.462.472-.705 1.179-.705 2.319 0 1.211.175 1.926.558 2.361.365.414 1.084.751 2.657.751 1.21 0 1.902-.394 2.344-.938.475-.584.742-1.44.878-2.497Z',
			},
			google: {
				color: '#4285F4',
				viewBox: '0 0 24 24',
				path: 'M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z',
			},
			mistral: {
				color: '#FA520F',
				viewBox: '0 0 24 24',
				path: 'M17.143 3.429v3.428h-3.429v3.429h-3.428V6.857H6.857V3.43H3.43v13.714H0v3.428h10.286v-3.428H6.857v-3.429h3.429v3.429h3.429v-3.429h3.428v3.429h-3.428v3.428H24v-3.428h-3.43V3.429z',
			},
			groq: {
				// Groq not in simple-icons; use a minimal "G" wordmark path
				color: '#F55036',
				viewBox: '0 0 24 24',
				path: 'M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2zm.5 5h2v1.5h-2V7zm-5 0h4v1.5H7.5V7zM12 18.5c-3.584 0-6.5-2.916-6.5-6.5 0-3.308 2.489-6.033 5.692-6.43v1.516C8.97 7.46 7 9.551 7 12c0 2.757 2.243 5 5 5 2.31 0 4.26-1.583 4.836-3.722H13.5V11.5h4.972c.018.163.028.329.028.5 0 3.584-2.916 6.5-6.5 6.5z',
			},
			bedrock: {
				color: '#FF9900',
				viewBox: '0 0 24 24',
				path: 'M6.763 10.036c0 .296.032.535.088.71.064.176.144.368.256.576.04.063.056.127.056.183 0 .08-.048.16-.152.24l-.503.335a.383.383 0 0 1-.208.072c-.08 0-.16-.04-.239-.112a2.47 2.47 0 0 1-.287-.375 6.18 6.18 0 0 1-.248-.471c-.622.734-1.405 1.101-2.347 1.101-.67 0-1.205-.191-1.596-.574-.391-.384-.59-.894-.59-1.533 0-.678.239-1.23.726-1.644.487-.415 1.133-.623 1.955-.623.272 0 .551.024.846.064.296.04.6.104.918.176v-.583c0-.607-.127-1.03-.375-1.277-.255-.248-.686-.367-1.3-.367-.28 0-.568.031-.863.103-.295.072-.583.16-.862.272a2.287 2.287 0 0 1-.28.104.488.488 0 0 1-.127.023c-.112 0-.168-.08-.168-.247v-.391c0-.128.016-.224.056-.28a.597.597 0 0 1 .224-.167c.279-.144.614-.264 1.005-.36a4.84 4.84 0 0 1 1.246-.151c.95 0 1.644.216 2.091.647.439.43.662 1.085.662 1.963v2.586zm-3.24 1.214c.263 0 .534-.048.822-.144.287-.096.543-.271.758-.51.128-.152.224-.32.272-.512.047-.191.08-.423.08-.694v-.335a6.66 6.66 0 0 0-.735-.136 6.02 6.02 0 0 0-.75-.048c-.535 0-.926.104-1.19.32-.263.215-.39.518-.39.917 0 .375.095.655.295.846.191.2.47.296.838.296zm6.41.862c-.144 0-.24-.024-.304-.08-.064-.048-.12-.16-.168-.311L7.586 5.55a1.398 1.398 0 0 1-.072-.32c0-.128.064-.2.191-.2h.783c.151 0 .255.025.31.08.065.048.113.16.16.312l1.342 5.284 1.245-5.284c.04-.16.088-.264.151-.312a.549.549 0 0 1 .32-.08h.638c.152 0 .256.025.32.08.063.048.12.16.151.312l1.261 5.348 1.381-5.348c.048-.16.104-.264.16-.312a.52.52 0 0 1 .311-.08h.743c.127 0 .2.065.2.2 0 .04-.009.08-.017.128a1.137 1.137 0 0 1-.056.2l-1.923 6.17c-.048.16-.104.263-.168.311a.51.51 0 0 1-.303.08h-.687c-.151 0-.255-.024-.32-.08-.063-.056-.119-.16-.15-.32l-1.238-5.148-1.23 5.14c-.04.16-.087.264-.15.32-.065.056-.177.08-.32.08zm10.256.215c-.415 0-.83-.048-1.229-.143-.399-.096-.71-.2-.918-.32-.128-.071-.215-.151-.247-.223a.563.563 0 0 1-.048-.224v-.407c0-.167.064-.247.183-.247.048 0 .096.008.144.024.048.016.12.048.2.08.271.12.566.215.878.279.319.064.63.096.95.096.502 0 .894-.088 1.165-.264a.86.86 0 0 0 .415-.758.777.777 0 0 0-.215-.559c-.144-.151-.416-.287-.807-.415l-1.157-.36c-.583-.183-1.014-.454-1.277-.813a1.902 1.902 0 0 1-.4-1.158c0-.335.073-.63.216-.886.144-.255.335-.479.575-.654.24-.184.51-.32.83-.415.32-.096.655-.136 1.006-.136.175 0 .359.008.535.032.183.024.35.056.518.088.16.04.312.08.455.127.144.048.256.096.336.144a.69.69 0 0 1 .24.2.43.43 0 0 1 .071.263v.375c0 .168-.064.256-.184.256a.83.83 0 0 1-.303-.096 3.652 3.652 0 0 0-1.532-.311c-.455 0-.815.071-1.062.223-.248.152-.375.383-.375.71 0 .224.08.416.24.567.159.152.454.304.877.44l1.134.358c.574.184.99.44 1.237.767.247.327.367.702.367 1.117 0 .343-.072.655-.207.926-.144.272-.336.511-.583.703-.248.2-.543.343-.886.447-.36.111-.734.167-1.142.167zM21.698 16.207c-2.626 1.94-6.442 2.969-9.722 2.969-4.598 0-8.74-1.7-11.87-4.526-.247-.223-.024-.527.272-.351 3.384 1.963 7.559 3.153 11.877 3.153 2.914 0 6.114-.607 9.06-1.852.439-.2.814.287.383.607zM22.792 14.961c-.336-.43-2.22-.207-3.074-.103-.255.032-.295-.192-.063-.36 1.5-1.053 3.967-.75 4.254-.399.287.36-.08 2.826-1.485 4.007-.215.184-.423.088-.327-.151.32-.79 1.03-2.57.695-2.994z',
			},
		azure: {
			color: '#0078D4',
			viewBox: '0 0 24 24',
			path: 'M22.379 23.343a1.62 1.62 0 0 0 1.536-2.14v.002L17.35 1.76A1.62 1.62 0 0 0 15.816.657H8.184A1.62 1.62 0 0 0 6.65 1.76L.086 21.204a1.62 1.62 0 0 0 1.536 2.139h4.741a1.62 1.62 0 0 0 1.535-1.103l.977-2.892 4.947 3.675c.28.208.618.32.966.32m-3.084-12.531 3.624 10.739a.54.54 0 0 1-.51.713v-.001h-.03a.54.54 0 0 1-.322-.106l-9.287-6.9h4.853m6.313 7.006c.116-.326.13-.694.007-1.058L9.79 1.76a1.722 1.722 0 0 0-.007-.02h6.034a.54.54 0 0 1 .512.366l6.562 19.445a.54.54 0 0 1-.338.684',
		},
		opencode: {
			color: '#656363',
			viewBox: '0 0 24 24',
			path: 'M2 2h20v20H2V2zm2 2v16h16V4H4z',
			fillRule: 'evenodd' as const,
			paths: ['M8 8h8v8H8z'],
		},
	};

		return (
			icons[provider] ?? {
				path: '',
				viewBox: '0 0 24 24',
				color: '#6b7280',
			}
		);
	}

	type ModelGroup = { provider: string | null; label: string; models: { label: string; value: string }[] };

	let groupedModels = $derived.by((): ModelGroup[] => {
		if (currentAgent !== 'opencode') return [];
		const map = new SvelteMap<string, { label: string; value: string }[]>();
		for (const m of fetchedModels) {
			const p = getProvider(m.value) ?? '__none__';
			if (!map.has(p)) map.set(p, []);
			map.get(p)!.push(m);
		}
		return Array.from(map.entries()).map(([p, models]) => ({
			provider: p === '__none__' ? null : p,
			label: p === '__none__' ? '' : formatProvider(p),
			models,
		}));
	});

	let currentProvider = $derived(getProvider(currentModel));
	let currentProviderIcon = $derived(getProviderIcon(currentProvider));

	function select(value: string) {
		updateSettings({ aiModel: value });
		open = false;
	}
</script>

<PopoverRoot bind:open>
	<PopoverTrigger>
		<button
			class="flex items-center gap-1.5 rounded-md px-2 py-1 transition-colors hover:bg-bg-secondary"
		>
		{#if currentProviderIcon.path}
			<svg
				width="14"
				height="14"
				viewBox={currentProviderIcon.viewBox}
				fill="currentColor"
				class="shrink-0 opacity-60 text-text-secondary"
				aria-hidden="true"
			>
				<path d={currentProviderIcon.path} fill-rule={currentProviderIcon.fillRule ?? 'nonzero'} />
				{#each currentProviderIcon.paths ?? [] as p}
					<path d={p} />
				{/each}
			</svg>
		{/if}
			<span class="text-xs text-text-secondary">{currentLabel}</span>
			<ChevronDown size={10} class="text-text-muted" />
		</button>
	</PopoverTrigger>
	<PopoverContent
		class="max-h-80 w-56 overflow-y-auto p-1"
		align="start"
		side="top"
	>
		{#if currentAgent === 'opencode'}
			{#each groupedModels as group, i (group.provider ?? '__none__')}
				{#if i > 0}
					<div class="my-1 border-t border-border"></div>
				{/if}
				{#if group.label}
					<div class="px-2 pt-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-text-muted">
						{group.label}
					</div>
				{/if}
				{@const icon = getProviderIcon(group.provider)}
				{#each group.models as opt (opt.value)}
					<button
						class="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-text-secondary transition-colors hover:bg-bg-tertiary"
						onclick={() => select(opt.value)}
					>
					<svg
						width="14"
						height="14"
						viewBox={icon.viewBox}
						fill="currentColor"
						class="shrink-0 opacity-60 text-text-secondary"
						aria-hidden="true"
					>
						<path d={icon.path} fill-rule={icon.fillRule ?? 'nonzero'} />
						{#each icon.paths ?? [] as p}
							<path d={p} />
						{/each}
					</svg>
					<span class="min-w-0 flex-1 truncate text-left">{opt.label}</span>
					{#if currentModel === opt.value}
						<Check size={12} class="shrink-0 text-accent" />
					{/if}
				</button>
			{/each}
		{/each}
	{:else}
		{#each fetchedModels as opt (opt.value)}
			{@const icon = getProviderIcon(getProvider(opt.value))}
			<button
				class="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-text-secondary transition-colors hover:bg-bg-tertiary"
				onclick={() => select(opt.value)}
			>
				<svg
					width="14"
					height="14"
					viewBox={icon.viewBox}
					fill="currentColor"
					class="shrink-0 opacity-60 text-text-secondary"
					aria-hidden="true"
				>
					<path d={icon.path} fill-rule={icon.fillRule ?? 'nonzero'} />
					{#each icon.paths ?? [] as p}
						<path d={p} />
					{/each}
				</svg>
					<span class="min-w-0 flex-1 truncate text-left">{opt.label}</span>
					{#if currentModel === opt.value}
						<Check size={12} class="shrink-0 text-accent" />
					{/if}
				</button>
			{/each}
		{/if}
	</PopoverContent>
</PopoverRoot>
