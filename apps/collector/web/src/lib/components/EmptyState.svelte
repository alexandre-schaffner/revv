<script lang="ts">
import { PulseIcon } from "phosphor-svelte";
import { dash } from "../dashboard.svelte";
</script>

<div class="mx-auto flex max-w-md flex-col items-center px-6 py-20 text-center">
  <span class="grid size-12 place-items-center rounded-lg" style:background-color="var(--accent-tint)">
    <PulseIcon size={24} weight="bold" style="color: var(--accent)" />
  </span>
  <h2 class="mt-5 text-base font-semibold text-ink">No telemetry yet</h2>
  <p class="mt-1.5 text-sm leading-relaxed text-ink-2">
    The collector is listening, but nothing has reported in the last
    {dash.windowMinutes >= 60 ? `${dash.windowMinutes / 60}h` : `${dash.windowMinutes}m`}.
    Exercise Revv and spans will stream in here.
  </p>
  <ul class="mt-5 flex flex-col gap-2 text-left text-[0.8125rem] text-ink-2">
    <li class="flex gap-2.5">
      <span class="nums select-none text-ink-muted">01</span>
      <span>Sync a repository to record GitHub API spans.</span>
    </li>
    <li class="flex gap-2.5">
      <span class="nums select-none text-ink-muted">02</span>
      <span>Generate a walkthrough to capture agent turns, tokens, and tool calls.</span>
    </li>
    <li class="flex gap-2.5">
      <span class="nums select-none text-ink-muted">03</span>
      <span>Click around the app — the web frontend reports RUM spans too.</span>
    </li>
  </ul>
</div>
