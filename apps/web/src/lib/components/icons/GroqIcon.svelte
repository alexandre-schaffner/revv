<script lang="ts">
let { size = 12, class: className = "" } = $props();
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="currentColor"
  xmlns="http://www.w3.org/2000/svg"
  class={className}
>
  <path d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2zm.5 5h2v1.5h-2V7zm-5 0h4v1.5H7.5V7zM12 18.5c-3.584 0-6.5-2.916-6.5-6.5 0-3.308 2.489-6.033 5.692-6.43v1.516C8.97 7.46 7 9.551 7 12c0 2.757 2.243 5 5 5 2.31 0 4.26-1.583 4.836-3.722H13.5V11.5h4.972c.018.163.028.329.028.5 0 3.584-2.916 6.5-6.5 6.5z"/>
</svg>
