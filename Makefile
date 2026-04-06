# -- mesh-chat Makefile --------------------------------------------------------
# Shortcuts for local development and Docker workflows.
#
# .PHONY tells Make that these targets are commands, not files. Without it,
# if a file named "build" existed, Make would say "build is up to date" and
# skip the recipe.
# -----------------------------------------------------------------------------

.PHONY: install build dev dev-server dev-client test clean \
        docker-build docker-up docker-down docker-logs

# -- Local Development --------------------------------------------------------

## Install all dependencies from the lock file.
install:
	npm ci

## Build all workspaces (common must be built first).
build:
	npm run build -w @mesh-chat/common
	npm run build -w @mesh-chat/server
	npm run build -w @mesh-chat/client

## Start the server in dev mode (tsx: on-the-fly TypeScript execution).
dev-server: build
	npm run dev -w @mesh-chat/server

## Start the Vite dev server for the React client.
dev-client:
	npm run dev -w @mesh-chat/client

## Start both server and client in parallel.
## Ctrl+C stops both processes.
dev: build
	@echo "Starting server and client..."
	@npm run dev -w @mesh-chat/server & \
	 npm run dev -w @mesh-chat/client & \
	 wait

## Run the full test suite.
test:
	npm test

# -- Docker -------------------------------------------------------------------

## Build all Docker images.
docker-build:
	docker compose -f docker/docker-compose.yml build

## Build and start the full mesh (3 servers + client).
docker-up:
	docker compose -f docker/docker-compose.yml up --build

## Stop containers and remove volumes (fresh database on next start).
docker-down:
	docker compose -f docker/docker-compose.yml down -v

## Follow live logs from all containers.
docker-logs:
	docker compose -f docker/docker-compose.yml logs -f

# -- Cleanup ------------------------------------------------------------------

## Remove build artifacts and node_modules.
clean:
	rm -rf common/dist server/dist client/dist node_modules
