# Source architecture

`plugins/` and `integrations/` are siblings because they have separate jobs.

- A **plugin** owns a local product surface: its manifest, page, domain, navigation placement, and the common data contracts it reads or writes.
- An **integration** owns a provider adapter: authorization, account tokens, provider API calls, sync cursors, and normalization into common data contracts.
- A connected account is an `integrations` database row. Multiple account rows may share one provider manifest and adapter.
- A workflow belongs to an account connection when it synchronizes provider data. Its definition identifies the provider runner and schedule.
- Built-in manifests and UI are bundled and trusted at build time. SQLite records installation/enabled state and instance configuration; it does not supply executable code or arbitrary file paths.

## Current layout

```text
src/
  plugins/
    registry.js
    calendar/{manifest.json,page.html}
    todos/{manifest.json,page.html}
    health/{manifest.json,page.html}
  integrations/
    registry.js
    google-calendar/{manifest.json,index.js}
    outlook-calendar/{manifest.json,index.js}
    fitbit/{manifest.json,index.js}
  db/database.js
  models/
    application-record.js        # shared app-owned connection and simple CRUD
    plugin.js
    integration.js
    integration-calendar.js
    workflow.js
    calendar-event.js
    todo-task.js
    health-metric.js
  test/
    models.test.js               # query parity and record behavior
  main.js
  preload.js
  renderer.js
```

The plugin and integration registries are build-time catalogs of bundled modules. `database.js` reads the same JSON manifests to register their metadata in SQLite. The renderer uses plugin manifests to resolve page templates and integration manifests to render provider cards.

`ApplicationRecord` owns the single SQLite connection for the Electron main process. Feature models inherit the connection and lightweight `find`, `all`, `create`, `save`, `delete`, `validate`, and transaction behavior. Domain-specific queries and sync operations remain explicit model methods; flexible `data_records` continue using their generic record contract. No extra ORM dependency is required.

The Google Calendar Desktop OAuth client ID is developer configuration supplied through `GOOGLE_CALENDAR_CLIENT_ID` (or a local, git-ignored `.env` file). The desktop client uses PKCE for authorization-code exchange and sends refresh requests without a client secret. No client secret is required or bundled. Connected accounts retain the client ID used at authorization time. Refresh tokens remain encrypted with Electron `safeStorage` in the matching integration record. See `.env.example` for the variable name.

## Calendar composition

```text
Provider account + integration manifest
        │ OAuth / scheduled sync
        ▼
Integration adapter ── normalize ──► data_records(calendar_events, v2)
                                             │
                                             ▼
                                  Calendar plugin page
```

## Local statement import composition

Finance statement imports use a manual workflow definition attached to the `finance` feature plugin. They are user-triggered jobs, not scheduled provider syncs.

```text
Native file picker (main process)
        │ selected path stays in main
        ▼
CSV service ── parse / map / normalize / fingerprint
        │ staged rows stay in main-process memory
        ▼
Finance preview UI ── user confirms included rows and duplicate choices
        │ narrow IPC request with session ID and row choices
        ▼
FinanceTransaction ── one SQLite transaction ──► data_records(finance_transactions, v2)
        │
        └── workflow_runs records stage, receipt, and failure status
```

`src/services/finance/statement-csv.js` is separated from Electron and the renderer so later bank-specific adapters can reuse the parser output contract and normalization path. Its generic implementation supports quoted CSV, comma/semicolon/tab delimiters, signed amounts or debit/credit columns, explicit sign conventions, common date formats, currency columns, and a bounded preview. Ambiguous dates and invalid rows remain visible for review instead of being silently guessed.

The preload bridge exposes only choose, preview, commit, and cancel operations. The renderer never receives an arbitrary-path read capability. Selected file contents and normalized staging rows stay in main-process memory; no source file or raw row is written to disk by import. The selected basename and source row are retained with imported transactions for provenance. A commit writes accepted rows atomically. The manual workflow run records coarse stage/count metadata and a receipt; stale running imports are marked cancelled at startup because their staged rows were not durable.

These boundaries are the reusable pattern for other local data pipelines: feature-owned workflow definition, a pure parser/normalizer service, narrow main-process orchestration, preview before mutation, an atomic model commit, and a compact run receipt. Bank-specific CSV presets and account reconciliation should wait for representative statement files and account requirements.

The next architecture step is moving each feature's page behavior into a plugin-owned renderer module that receives a small capability API (`getPageData`, `createRecord`, `updateRecord`, and UI helpers). Workflow execution remains in the main process and uses explicit provider runner registration. This keeps renderer code away from secrets and native Electron APIs.
