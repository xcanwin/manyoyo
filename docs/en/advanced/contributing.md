---
title: Contributing | MANYOYO
description: For contributors, covering running MANYOYO from source, running tests, building the frontend and the docs, and an outline of the release process.
---

# Contributing

For people who want to change MANYOYO itself. Collaboration conventions for AI coding assistants live in [`AGENTS.md`](https://github.com/xcanwin/manyoyo/blob/main/AGENTS.md) at the repository root; this page is the human-readable outline.

## Run from source

Requires Node.js >= 22 and Docker or Podman.

```bash
git clone https://github.com/xcanwin/manyoyo.git && cd manyoyo
npm install
node bin/manyoyo.js --help      # run directly
npm link                        # or link the global commands manyoyo / my
```

## Tests

```bash
npm run test:unit               # during development: Jest unit tests + frontend Vitest (fast)
npm test                        # before committing: Jest with coverage + frontend Vitest
npm run test:integration        # integration tests that need a real container runtime
```

## Web frontend

The web UI source is `frontend/` at the repository root (Vite + React + TypeScript + shadcn/ui); the build output is the single file `lib/web/index.html`.

```bash
cd frontend && npm ci && cd ..   # install its own dependencies once
npm run build:web                # build
npm run dev:web                  # hot-reload development (run manyoyo serve in another terminal as the backend)
```

See `frontend/AGENTS.md` for details and conventions, and `lib/web/AGENTS.md` for server-side constraints.

## Documentation site

The docs use **VitePress** and are deployed to GitHub Pages by GitHub Actions after a push to `main`. Chinese is the primary language; English is updated in the same change and kept structurally identical.

```bash
npm ci --include=optional        # install first, then build; do not run them in parallel
npm run docs:dev                 # local development, listens on 127.0.0.1:5173 only
npm run docs:build               # build and check dead links
```

## Release outline

Releases are done by the maintainer: the `npm run dev:release` wizard handles the version and release commit; installers, images and the Release are built only in CI and privacy-scanned. The full order is in the "release order" section of [`AGENTS.md`](https://github.com/xcanwin/manyoyo/blob/main/AGENTS.md).

## Next Steps

- [Custom Image](./custom-image.md)
- [Session Management and Recovery](./session-management.md)
