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

The Google Calendar Desktop OAuth client ID and client secret are developer configuration supplied through `GOOGLE_CALENDAR_CLIENT_ID` and `GOOGLE_CALENDAR_CLIENT_SECRET` (or a local, git-ignored `.env` file). Desktop clients are public clients and cannot keep the client secret confidential; it is sent to Google's token endpoint alongside PKCE. The secret must not be committed. Connected accounts retain the client ID used at authorization time so token refresh continues to work if the environment configuration later changes. Refresh tokens remain encrypted with Electron `safeStorage` in the matching integration record. See `.env.example` for the variable names.

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

The next architecture step is moving each feature's page behavior into a plugin-owned renderer module that receives a small capability API (`getPageData`, `createRecord`, `updateRecord`, and UI helpers). Workflow execution remains in the main process and uses explicit provider runner registration. This keeps renderer code away from secrets and native Electron APIs.
