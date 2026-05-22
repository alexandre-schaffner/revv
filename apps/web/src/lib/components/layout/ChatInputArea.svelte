<script lang="ts">
import { Lightbulb } from "phosphor-svelte";
import {
  PromptInput,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  type PromptInputMessage,
  type PromptInputStatus,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "$lib/components/ai/prompt-input";
import {
  abortChatTurn,
  enqueueMessage,
  getInteractionMode,
  isChatStreaming,
  isPlanModeAvailable,
  sendChatMessage,
  setInteractionMode,
} from "$lib/stores/chat.svelte";

interface Props {
  prId: string | undefined;
}

let { prId }: Props = $props();

const isStreaming = $derived(prId ? isChatStreaming(prId) : false);
const inputStatus = $derived<PromptInputStatus>(isStreaming ? "streaming" : "ready");
const interactionMode = $derived(prId ? getInteractionMode(prId) : "default");
const planModeAvailable = $derived(isPlanModeAvailable());

function handlePromptSubmit(message: PromptInputMessage): void {
  if (!prId) return;
  const value = message.text.trim();
  if (value.length === 0) return;
  if (isStreaming) {
    enqueueMessage(prId, value);
  } else {
    sendChatMessage({ prId, message: value });
  }
}

function handleStop(): void {
  if (!prId) return;
  abortChatTurn(prId);
}

function handleTogglePlanMode(): void {
  if (!prId || !planModeAvailable) return;
  const next = interactionMode === "plan" ? "default" : "plan";
  void setInteractionMode(prId, next);
}
</script>

<div class="chat-input-area">
  <PromptInput
    onsubmit={handlePromptSubmit}
    onstop={handleStop}
    status={inputStatus}
    class="chat-prompt-input"
  >
    <PromptInputBody>
      <PromptInputTextarea
        placeholder="Ask anything…"
        disabled={!prId}
        class="text-sm"
      />
    </PromptInputBody>
    <PromptInputFooter>
      <PromptInputTools>
        <PromptInputButton
          tooltip={
            planModeAvailable
              ? interactionMode === 'plan'
                ? 'Plan mode is on — the agent will propose a plan instead of editing. Click to disable.'
                : 'Enable plan mode: ask the agent to propose a plan first.'
              : 'Plan mode requires an opencode install with a `plan` agent.'
          }
          onclick={handleTogglePlanMode}
          disabled={!prId || !planModeAvailable}
          aria-pressed={interactionMode === 'plan'}
          class={interactionMode === 'plan' ? 'bg-accent/15 text-accent hover:bg-accent/25 hover:text-accent' : ''}
        >
          <Lightbulb class="size-3.5" />
        </PromptInputButton>
      </PromptInputTools>
      <PromptInputSubmit disabled={!prId} />
    </PromptInputFooter>
  </PromptInput>
</div>

<style>
  .chat-input-area {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    z-index: 20;
    padding: 12px 12px 16px;
    background: transparent;
  }

  :global(.chat-prompt-input) {
    border-radius: 12px !important;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(255, 255, 255, 0.05) !important;
    backdrop-filter: blur(8px);
    transition: box-shadow var(--duration-quick) ease-out-expo;
  }

  :global(.chat-prompt-input:focus-within) {
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(255, 255, 255, 0.08) !important;
  }

  :global(.chat-prompt-input [data-slot="prompt-input-body"]) {
    padding: 2px 0 0 !important;
  }

  :global(.chat-prompt-input textarea) {
    height: 22px !important;
    min-height: 22px !important;
    line-height: 1.3 !important;
    padding: 6px 14px !important;
  }

  :global(.chat-prompt-input [data-slot="prompt-input-footer"]) {
    padding: 6px 12px 8px !important;
  }
</style>
