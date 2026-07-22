# ──────────────────────────────────────────────────────────────
# Revv — Build & Development Commands
# ──────────────────────────────────────────────────────────────

.PHONY: install dev build dist clean typecheck lint format format-check help cache-emulator-up cache-emulator-down dev-cache-emulator dev-desktop-cache-emulator

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

# Dev env: use a different port/db/clone-dir so dev doesn't clash with the
# installed (production) Revv instance running in the background.
DEV_ENV = REVV_CHANNEL=dev PORT=45679 REVV_DB_PATH=./revv-dev.db REVV_CLONE_DIR=$$HOME/.revv/repos-dev VITE_REVV_CHANNEL=dev VITE_API_PORT=45679 REV_DEBUG=1

dev: kill-server ## Start all services in development mode
	$(DEV_ENV) bun run dev

dev-server: kill-server ## Start only the API server (port 45679)
	REV_DEBUG=1 REVV_CHANNEL=dev PORT=45679 REVV_DB_PATH=./revv-dev.db REVV_CLONE_DIR=$$HOME/.revv/repos-dev bun run dev:server

dev-desktop: kill-server ## Start the Tauri desktop app in dev mode
	$(DEV_ENV) bun run dev:desktop

kill-server: ## Kill any stale dev server processes (uses PID files; safe to run at any time)
	@if [ -f apps/server/revv-dev.db.dev.pid ]; then \
	  pid=$$(cat apps/server/revv-dev.db.dev.pid 2>/dev/null); \
	  if [ -n "$$pid" ] && kill -0 "$$pid" 2>/dev/null; then \
	    printf "[kill-server] killing stale dev server (PID $$pid)…\n"; \
	    kill "$$pid" 2>/dev/null || true; \
	    sleep 1; \
	    kill -9 "$$pid" 2>/dev/null || true; \
	  fi; \
	  rm -f apps/server/revv-dev.db.dev.pid; \
	fi

# ── Team Cache Emulator (fake-gcs-server) ─────────────────────

# fake-gcs-server stand-in for GCS. The @google-cloud/storage SDK honors
# STORAGE_EMULATOR_HOST, so pointing the server at a local container is
# enough to exercise upload + hydrate without touching a real bucket.
CACHE_EMULATOR_CONTAINER = revv-gcs-emulator
CACHE_EMULATOR_PORT      = 4443
CACHE_EMULATOR_BUCKET    = revv-cache-test

cache-emulator-up: ## Start fake-gcs-server in Docker and create the test bucket
	@if docker ps --format '{{.Names}}' | grep -q '^$(CACHE_EMULATOR_CONTAINER)$$'; then \
	  printf "[cache-emulator] already running on :$(CACHE_EMULATOR_PORT)\n"; \
	else \
	  if docker ps -a --format '{{.Names}}' | grep -q '^$(CACHE_EMULATOR_CONTAINER)$$'; then \
	    docker rm -f $(CACHE_EMULATOR_CONTAINER) >/dev/null; \
	  fi; \
	  printf "[cache-emulator] starting fake-gcs-server on :$(CACHE_EMULATOR_PORT)…\n"; \
	  docker run -d --name $(CACHE_EMULATOR_CONTAINER) \
	    -p $(CACHE_EMULATOR_PORT):4443 \
	    fsouza/fake-gcs-server \
	    -scheme http -public-host localhost:$(CACHE_EMULATOR_PORT) >/dev/null; \
	fi
	@printf "[cache-emulator] waiting for HTTP readiness…\n"
	@for i in 1 2 3 4 5 6 7 8 9 10; do \
	  if curl -sf "http://localhost:$(CACHE_EMULATOR_PORT)/storage/v1/b" >/dev/null 2>&1; then break; fi; \
	  sleep 1; \
	done
	@printf "[cache-emulator] ensuring bucket \"$(CACHE_EMULATOR_BUCKET)\" exists…\n"
	@curl -s -o /dev/null -w "  POST /b → %{http_code}\n" \
	  -X POST "http://localhost:$(CACHE_EMULATOR_PORT)/storage/v1/b" \
	  -H "Content-Type: application/json" \
	  -d '{"name":"$(CACHE_EMULATOR_BUCKET)"}'
	@printf "[cache-emulator] ready. Configure Settings → Team Cache with:\n"
	@printf "  bucket:      $(CACHE_EMULATOR_BUCKET)\n"
	@printf "  credentials: any structurally-valid SA JSON (emulator ignores auth)\n"

cache-emulator-down: ## Stop and remove the fake-gcs-server container
	@if docker ps -a --format '{{.Names}}' | grep -q '^$(CACHE_EMULATOR_CONTAINER)$$'; then \
	  docker rm -f $(CACHE_EMULATOR_CONTAINER) >/dev/null; \
	  printf "[cache-emulator] stopped.\n"; \
	else \
	  printf "[cache-emulator] not running.\n"; \
	fi

dev-cache-emulator: cache-emulator-up kill-server ## Start the dev server pointed at the local fake-gcs-server
	REVV_CACHE_API_ENDPOINT=http://localhost:$(CACHE_EMULATOR_PORT) $(DEV_ENV) bun run dev:server

dev-desktop-cache-emulator: cache-emulator-up kill-server ## Start the Tauri desktop app pointed at the local fake-gcs-server
	REVV_CACHE_API_ENDPOINT=http://localhost:$(CACHE_EMULATOR_PORT) $(DEV_ENV) bun run dev:desktop

# ── Build ─────────────────────────────────────────────────────

build: ## Build all packages (web + server + shared)
	bun run build

build-web: ## Build the web frontend only
	cd apps/web && bun run build

build-server: ## Build the API server only
	cd apps/server && bun run build

# ── Distribution ──────────────────────────────────────────────

dist: ## Build the Revv.app bundle used by the source installer
	@printf "\n\033[1m\033[36m▸ Building Revv distribution package...\033[0m\n\n"
	@printf "  Step 1/3: Building shared package\n"
	cd packages/shared && bun run typecheck
	@printf "  Step 2/3: Building web frontend + API server\n"
	bun run build
	@printf "  Step 3/3: Building Tauri desktop bundle (.app only)\n"
	# --bundles app skips the DMG. Revv is distributed via source install,
	# not via a signed DMG, and tauri-bundler's bundle_dmg.sh has been flaky
	# on machines where it's blocked from Finder/AppleEvents. Use `make dmg`
	# explicitly if you actually need the .dmg.
	cd apps/desktop && bunx tauri build --bundles app
	@printf "\n\033[1m\033[32m  Build complete!\033[0m\n"
	@printf "  Bundle located in: apps/desktop/target/release/bundle/macos/\n\n"

dmg: ## Build the full DMG installer (requires Finder/AppleEvents permission)
	cd apps/desktop && bunx tauri build --bundles dmg

dist-debug: ## Build a debug distribution (faster, larger binary)
	cd apps/desktop && bunx tauri build --debug --bundles app

# ── Quality ───────────────────────────────────────────────────

typecheck: ## Run TypeScript type checking across all packages
	bun run typecheck

lint: ## Run linter + format check (Biome)
	bun run lint

format: ## Auto-format all files (Biome)
	bun run format

format-check: ## Check formatting without writing (Biome)
	bun run format:check

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

reset-db: ## Delete the local dev database (will be recreated on next server start)
	rm -f revv-dev.db revv-dev.db-shm revv-dev.db-wal
	rm -f apps/server/revv-dev.db apps/server/revv-dev.db-shm apps/server/revv-dev.db-wal
	rm -f ~/.revv/settings.json
	@printf "Dev database and settings deleted. Both will be recreated on next server start.\n"
