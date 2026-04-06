# mesh-chat

This repo is a part of an AI-Assisted learning project. The result was an end-to-end encrypted chat application with an n-to-n mesh server topology including comments to help better understand OOP principles.

Each server connects to every other server via WebSockets. Clients connect to
their local server via Socket.io. Messages are encrypted client-side with
RSA-OAEP so servers never see plaintext. Network state is managed through gossip messages between servers.

The full project explanation can be found [on my website](https://aedangallivan.com).

## Tech stack

### Server

- Express.js (Node.js server)
- Native Node.js WebSockets (server to server WebSocket Connection)
- Socket.io (client to server WebSocket Connection)
- uuid (UUIDs)
- Argon2id (hashing) 
- WebCrypto library (encrypting, decrypting, signing)
- Better SQlite3 (Database)

### Client

- React + TypeScript (client, UI)
- Argon2id (KDF)
- WebCrypto library (AES-256-GCM, encryption, decryption, signing, CryptoKey importing/caching)
- Socket.io (client to server WebSocket Connection)

### Other

- Vitest (testing for client and server)
- Supertest (testing Express Auth routes)
- Docker (simulating n-to-n server mesh via networked containers)

## Prerequisites

Make sure to have:
- Node.js 22+ and npm 10+
- Docker and Docker Compose (for the mesh simulation)

## Cloning the repo

```bash
git clone https://github.com/AedanG1/mesh-chat.git

# OR if using SSH
git clone git@github.com:AedanG1/mesh-chat.git

cd mesh-chat
```

## Project Structure

```
mesh-chat/
  common/   - Shared types, encoding utilities, and protocol constants
  server/   - Express + WebSocket mesh server
  client/   - React + Vite frontend
  docker/   - Dockerfiles and docker-compose.yml
```

The project uses npm workspaces. All three packages (`common`, `server`,
`client`) are installed and linked from the root `package.json`.

## Quick Start

```sh
make install   # npm ci - install dependencies from the lock file
make dev       # start the server and Vite client in parallel
```

The client opens at `http://localhost:5173` and the single server listens on port `9000`.

## Local Development

Local development runs a single server instance and the Vite dev server.

### 1. Install dependencies

```sh
make install
```

This runs `npm ci`, which installs exactly what is in `package-lock.json`.

### 2. Build all workspaces

```sh
make build
```

Compiles TypeScript for `common`, `server`, and `client` in the correct order.
`common` is built first because both `server` and `client` import from it.

### 3. Start both at once

```sh
make dev
```

Runs the server and client as parallel background processes. Press `Ctrl+C` to
stop both.

#### Alternatively, start them separately

```sh
make dev-server
```

Runs the server with `tsx` (on-the-fly TypeScript execution) on port `9000`.
The `build` target runs automatically as a prerequisite.

And in a separate terminal:

```sh
make dev-client
```

Starts Vite's dev server on `http://localhost:5173`.

### 4. Run tests

```sh
make test
```

Runs the full Vitest test suite across all workspaces.

## Docker (Mesh Simulation)

Docker simulates the full n-to-n mesh with three servers and a static client
served by nginx.

### Start the mesh

```sh
make docker-up
```

This builds all images and starts four containers:

| Service   | Internal Port | Host Port | Role                        |
|-----------|---------------|-----------|-----------------------------|
| server1   | 9000          | 3001      | Seed node (no bootstrap)    |
| server2   | 9000          | 3002      | Joins via server1           |
| server3   | 9000          | 3003      | Joins via server1 + server2 |
| client    | 5173          | 5173      | nginx serving the Vite build|

Open `http://localhost:5173` in your browser. In the login/register form, enter
one of the server URLs to connect to:

- `http://localhost:3001` (server1)
- `http://localhost:3002` (server2)
- `http://localhost:3003` (server3)

Users on different servers can message each other. The servers route messages
through the mesh automatically.

### View logs

```sh
make docker-logs
```

Follows the combined log output from all containers. You will see the mesh join
sequence, heartbeat pings, and message routing.

### Stop and reset

```sh
make docker-down
```

Stops all containers and removes the Docker volumes. Each server's SQLite
database is stored in a volume, so this gives you a clean slate on the next
start.

### Rebuild after code changes

`make docker-up` includes the `--build` flag, so it rebuilds images
automatically when source files change. You can also build without starting:

```sh
make docker-build
```

## Cleanup

```sh
make clean
```

Removes all `dist/` directories and `node_modules/`. Run `make install` after
this to restore dependencies.

## Makefile Reference

| Target         | Description                                        |
|----------------|----------------------------------------------------|
| `install`      | Install dependencies (`npm ci`)                    |
| `build`        | Build all workspaces in order                      |
| `dev-server`   | Start the server with tsx (builds first)           |
| `dev-client`   | Start the Vite dev server                          |
| `dev`          | Start server + client in parallel                  |
| `test`         | Run the full test suite                            |
| `docker-build` | Build Docker images                                |
| `docker-up`    | Build and start the full mesh                      |
| `docker-down`  | Stop containers and remove volumes                 |
| `docker-logs`  | Follow live container logs                         |
| `clean`        | Remove build artifacts and node_modules            |
