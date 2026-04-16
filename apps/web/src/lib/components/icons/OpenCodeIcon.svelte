<script lang="ts">
  let { size = 12, class: className = '' } = $props();
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  xmlns="http://www.w3.org/2000/svg"
  class={className}
>
  <!-- Outer frame -->
  <path fill-rule="evenodd" clip-rule="evenodd" d="M2 2h20v20H2V2zm2 2v16h16V4H4z" fill="currentColor"/>
  <!-- Inner square -->
  <rect x="8" y="8" width="8" height="8" fill="currentColor"/>
</svg>
