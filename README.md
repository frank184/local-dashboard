# Local Dashboard

A local-first desktop dashboard built with Electron, Vite, and SQLite. The app is intended to bring personal tools and connected services into one local workspace, with plugins owning product surfaces and integrations handling external accounts and data sync.

## Run locally

```sh
npm install
npm start
```

`npm start` builds the renderer with Vite and launches Electron. To build only the renderer, run `npm run build`.

Run the model and SQLite behavior tests with `npm test`.

The SQLite database is stored in Electron's per-user application data directory. Google Calendar's public OAuth client ID can be supplied through `GOOGLE_CALENDAR_CLIENT_ID`; see [.env.example](.env.example).

## Project map

- `src/main.js` — Electron main process and IPC handlers
- `src/preload.js` — narrow renderer capability bridge
- `src/renderer.js` and `src/styles.css` — desktop UI
- `src/plugins/` — bundled product pages and manifests
- `src/integrations/` — bundled provider adapters and manifests
- `src/db/database.js` — SQLite migrations and starter data
- `src/models/` — shared `ApplicationRecord` plus feature models
- `test/` — Node built-in tests for model CRUD and query compatibility
- `docs/` — product and UI conventions
- `src/ARCHITECTURE.md` — current code and plugin/integration boundaries

## Documentation

Start at [docs/README.md](docs/README.md) for the documentation index. UI layout and motion conventions live in [docs/ui/design-principles.md](docs/ui/design-principles.md).
