<script lang="ts">
  interface Props {
    filePath: string;
    startLine?: number | undefined;
    endLine?: number | undefined;
    onclick?: (() => void) | undefined;
  }
  let { filePath, startLine, endLine, onclick }: Props = $props();

  function getLangLabel(ext: string): { abbr: string; color: string } {
    switch (ext) {
      case '.ts':
      case '.tsx':  return { abbr: 'TS',  color: '#3178c6' };
      case '.js':
      case '.jsx':
      case '.mjs':
      case '.cjs':  return { abbr: 'JS',  color: '#a37f00' };
      case '.svelte': return { abbr: 'SV', color: '#ff3e00' };
      case '.css':
      case '.scss':
      case '.sass':
      case '.less': return { abbr: 'CSS', color: '#2965f1' };
      case '.json': return { abbr: 'JSON', color: '#6b7280' };
      case '.yaml':
      case '.yml':  return { abbr: 'YML', color: '#6b7280' };
      case '.toml': return { abbr: 'TOML', color: '#6b7280' };
      case '.md':
      case '.mdx':  return { abbr: 'MD',  color: '#6b7280' };
      case '.html': return { abbr: 'HTML', color: '#e34c26' };
      case '.sh':
      case '.bash':
      case '.zsh':  return { abbr: 'SH',  color: '#4eaa25' };
      case '.rs':   return { abbr: 'RS',  color: '#ce422b' };
      case '.py':   return { abbr: 'PY',  color: '#3572a5' };
      case '.go':   return { abbr: 'GO',  color: '#00add8' };
      default:      return { abbr: 'FILE', color: '#6b7280' };
    }
  }

  const fileName = $derived(filePath.split('/').at(-1) ?? filePath);
  const ext = $derived(fileName.includes('.') ? '.' + fileName.split('.').at(-1) : '');
  const lang = $derived(getLangLabel(ext));
  const tooltip = $derived(startLine != null
    ? `${filePath}:${startLine}${endLine != null && endLine !== startLine ? `-${endLine}` : ''}`
    : filePath);
</script>

{#if onclick}
  <button type="button" class="file-badge" {onclick} title={tooltip}>
    <span class="file-badge-chip" style="color: {lang.color};">{lang.abbr}</span>
    <span class="file-badge-name">{fileName}</span>
  </button>
{:else}
  <span class="file-badge" title={tooltip}>
    <span class="file-badge-chip" style="color: {lang.color};">{lang.abbr}</span>
    <span class="file-badge-name">{fileName}</span>
  </span>
{/if}

<style>
  .file-badge {
    display: inline-flex;
    align-items: center;
    gap: 0;
    padding: 0;
    border-radius: 6px;
    background: var(--color-bg-elevated);
    border: 1px solid var(--color-border-shadcn);
    font-size: 11.5px;
    font-family: var(--font-sans, system-ui, sans-serif);
    color: var(--color-text-primary);
    cursor: default;
    transition: background 0.12s ease, border-color 0.12s ease, box-shadow 0.12s ease;
    text-align: left;
    overflow: hidden;
    width: fit-content;
    /* reset button styles */
    appearance: none;
    text-decoration: none;
  }

  button.file-badge {
    cursor: pointer;
  }

  button.file-badge:hover {
    background: color-mix(in srgb, var(--color-bg-tertiary) 80%, var(--color-bg-primary));
    border-color: color-mix(in srgb, var(--color-text-primary) 18%, transparent);
    box-shadow: 0 1px 4px color-mix(in srgb, var(--color-text-primary) 6%, transparent);
  }

  button.file-badge:hover .file-badge-chip {
    background: color-mix(in srgb, currentColor 18%, transparent);
  }

  .file-badge-chip {
    display: flex;
    align-items: center;
    align-self: stretch;
    padding: 0 5px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.03em;
    background: color-mix(in srgb, currentColor 10%, transparent);
    border-right: 1px solid var(--color-border-shadcn);
    white-space: nowrap;
  }

  .file-badge-name {
    display: flex;
    align-items: center;
    align-self: stretch;
    padding: 0 7px;
    font-weight: 500;
    background: var(--color-bg-tertiary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--color-text-muted);
  }
</style>
