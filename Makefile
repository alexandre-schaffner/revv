# ──────────────────────────────────────────────────────────────
# Rev — Build & Development Commands
# ──────────────────────────────────────────────────────────────

.PHONY: install dev build dist clean typecheck help

# Default target
help: ## Show this help
	@printf "\n  \033[1mRev — AI-Powered Code Review\033[0m\n\n"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'
	@printf "\n"

# ── Setup ─────────────────────────────────────────────────────

install: ## Set up development environment (install all dependencies)
	@./install.sh

install-deps: ## Install project dependencies only (skip tool checks)
	bun install

# ── Development ───────────────────────────────────────────────

dev: ## Start all services in development mode
	bun run dev

dev-web: ## Start only the web frontend (port 5173)
	bun run dev:web

dev-server: ## Start only the API server (port 45678)
	bun run dev:server

dev-desktop: ## Start the Tauri desktop app in dev mode
	bun run dev:desktop

# ── Build ─────────────────────────────────────────────────────

build: ## Build all packages (web + server + shared)
	bun run build

build-web: ## Build the web frontend only
	cd apps/web && bun run build

build-server: ## Build the API server only
	cd apps/server && bun run build

# ── Distribution ──────────────────────────────────────────────

dist: ## Build platform installer (.dmg on macOS, .msi on Windows, .deb on Linux)
	@printf "\n\033[1m\033[36m▸ Building Rev distribution package...\033[0m\n\n"
	@printf "  Step 1/3: Building shared package\n"
	cd packages/shared && bun run typecheck
	@printf "  Step 2/3: Building web frontend + API server\n"
	bun run build
	@printf "  Step 3/3: Building Tauri desktop installer\n"
	cd apps/desktop && bunx tauri build
	@printf "\n\033[1m\033[32m  Build complete!\033[0m\n"
	@printf "  Installer located in: apps/desktop/target/release/bundle/\n\n"

dist-debug: ## Build a debug distribution (faster, larger binary)
	cd apps/desktop && bunx tauri build --debug

# ── Quality ───────────────────────────────────────────────────

typecheck: ## Run TypeScript type checking across all packages
	bun run typecheck

lint: ## Run linters across all packages
	bun run lint

# ── Maintenance ───────────────────────────────────────────────

clean: ## Remove all build artifacts
	@printf "Cleaning build artifacts...\n"
	rm -rf apps/web/build apps/web/.svelte-kit
	rm -rf apps/server/dist
	rm -rf apps/desktop/target
	rm -rf node_modules/.cache .turbo
	@printf "Done.\n"

clean-all: clean ## Remove build artifacts AND node_modules
	rm -rf node_modules
	rm -rf apps/web/node_modules
	rm -rf apps/server/node_modules
	rm -rf packages/shared/node_modules

reset-db: ## Delete the local database (will be recreated on next server start)
	rm -f apps/server/revv.db apps/server/revv.db-shm apps/server/revv.db-wal
	@printf "Database deleted. It will be recreated on next server start.\n"
