# @revv/desktop-electrobun

Electrobun desktop shell for Revv. Wraps `@revv/app` in a native window with system webview.

## Development

```bash
# From repo root — starts both the frontend dev server and Electrobun:
make dev-electrobun

# Or manually:
cd packages/app && bun run dev     # Start frontend on port 3000
cd apps/desktop-electrobun && bun run dev  # Start Electrobun shell
```

## Build

```bash
bun run build  # Build platform installer
```
