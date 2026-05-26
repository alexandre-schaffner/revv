<script lang="ts">
import AnthropicIcon from "./AnthropicIcon.svelte";
import AzureIcon from "./AzureIcon.svelte";
import BedrockIcon from "./BedrockIcon.svelte";
import GitHubCopilotIcon from "./GitHubCopilotIcon.svelte";
import GoogleIcon from "./GoogleIcon.svelte";
import GroqIcon from "./GroqIcon.svelte";
import MistralIcon from "./MistralIcon.svelte";
import OpenAIIcon from "./OpenAIIcon.svelte";
import OpenCodeIcon from "./OpenCodeIcon.svelte";

interface Props {
  provider: string | null;
  size?: number;
  class?: string;
}

let { provider, size = 14, class: className = "" }: Props = $props();

const ICON_MAP: Record<string, typeof AnthropicIcon> = {
  anthropic: AnthropicIcon,
  openai: OpenAIIcon,
  "github-copilot": GitHubCopilotIcon,
  google: GoogleIcon,
  mistral: MistralIcon,
  groq: GroqIcon,
  bedrock: BedrockIcon,
  azure: AzureIcon,
  opencode: OpenCodeIcon,
};

const IconComponent = $derived(provider ? ICON_MAP[provider] : null);
</script>

{#if IconComponent}
  <IconComponent size={size} class={className} />
{/if}
