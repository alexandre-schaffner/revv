<script lang="ts">
import { Dotmatrix } from "$lib/components/ui/dotmatrix";

interface Props {
  /** Accessible label. */
  label?: string;
}

let { label = "Loading…" }: Props = $props();
</script>

<div class="dot-matrix-loader" role="status" aria-label={label}>
  <Dotmatrix variant="square-19" />
  <span class="sr-only">{label}</span>
</div>

<style>
.dot-matrix-loader {
  display: grid;
  place-items: center;
  padding: 1rem;
  width: 100%;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
</style>
