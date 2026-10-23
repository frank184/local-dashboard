# Models

This folder contains the small SQLite model layer used by the Electron main
process. `ApplicationRecord` owns the database connection; feature models add
table metadata, validation, and domain-specific queries or persistence rules.

## Connection lifecycle

Open and migrate the database during main-process startup, then connect once:

```js
const { ApplicationRecord } = require('./models');

ApplicationRecord.connect(database);
```

All models share that connection. Close it during shutdown with
`ApplicationRecord.disconnect()`. Model calls are synchronous and should stay
in the main process; the renderer should use the app's IPC APIs instead of
opening SQLite directly.

## Defining a simple model

For a conventional table, define its table name, defaults, and the columns
managed by `save()`:

```js
const { ApplicationRecord } = require('./models');
const crypto = require('node:crypto');

class Note extends ApplicationRecord {
  static get tableName() { return 'notes'; }
  static get columns() { return ['id', 'title']; }
  static get defaults() { return { id: () => crypto.randomUUID(), title: 'Untitled' }; }

  validate() {
    if (!this.title?.trim()) throw new Error('Title is required.');
  }
}

const note = Note.create({ title: 'Plan the week' });
note.update({ title: 'Plan tomorrow' });
const sameNote = Note.find(note.id);
note.delete();
```

`id` is the default primary key. Override `static get primaryKey()` for a
legacy table with a different key. `defaults` is applied by the base constructor for both `new Model(attrs)` and `Model.create(attrs)`. Literal values are copied; function values are
treated as factories and receive the attributes accumulated so far, which lets
one default refer to an earlier one (for example,
`external_id: (record) => record.id`). Explicit attributes always override
defaults. `columns` is an allowlist for inherited `save()`; it does not create
or migrate tables. Schema changes belong in the SQLite migration layer.

If a default needs model behavior, put it in the lifecycle hook `beforeCreate()`
so every creation path gets it. For example, `Plugin` generates a unique
slug-style ID there. Callers still use the shared `Plugin.create(attrs)` API;
they do not need a parallel `createPlugin()` method.

## Inherited API

| Call | Behavior |
| --- | --- |
| `ApplicationRecord.connect(db)` | Set the shared connection once. |
| `ApplicationRecord.disconnect()` | Close and clear the shared connection. |
| `Model.create(attributes)` | Construct and save; return the model instance. |
| `Model.find(id)` | Return one model instance or `null`. |
| `Model.all()` | Return all rows as model instances. |
| `Model.update(id, attributes)` | Update an existing row; return the model or `null`. |
| `Model.delete(id)` | Delete by primary key; return whether a row was removed. |
| `record.save()` / `record.update(attributes)` | Persist a record and return it. |
| `record.delete()` | Delete that record; return whether it was removed. |
| `Model.transaction(() => …)` | Commit synchronous work together, or roll it back on error. |

The shared query API also includes:

```js
CalendarEvent.where({ source_plugin_id: 'google-calendar' }, { orderBy: 'occurred_at' });
CalendarEvent.deleteWhere({ source_plugin_id: 'google-calendar', external_id: { $in: ids } });
IntegrationCalendar.upsertAll(rows, {
  uniqueBy: ['integration_id', 'external_calendar_id'],
  updateColumns: ['summary', 'timezone', 'color'],
});
ApplicationRecord.query('SELECT ... JOIN ... WHERE id = ?', id);
ApplicationRecord.execute('UPDATE table_name SET value = ? WHERE id = ?', value, id);
```

Models may declare `defaultScope`, `defaultOrderBy`, and `payloadColumn` to
keep type filters and common row decoding beside the table definition. SQL
identifiers are checked against the model's `columns`; values are bound as
parameters. Use `query` for joins/aggregates and `where` for ordinary record
queries. Full method comments live beside each method in
[`application-record.js`](./application-record.js).

Use a property setter for normalization that belongs to one attribute. For
example, `TodoTask.title` trims on assignment and `TodoTask.completed`
normalizes to a boolean. When a setter uses a backing property, declare the
mapping in `static get attributeBackings()` so `toJSON()` exposes the public
attribute name and hides the backing field. Keep validation for rules that
decide whether a record may be saved, and keep defaults for values that are
absent rather than values that need normalization.

## Current models

- `Plugin` stores built-in/installed plugin metadata.
- `Integration` manages connected provider accounts, credentials metadata,
  sync state, and provider sync workflow setup.
- `IntegrationCalendar` stores calendars discovered through a calendar
  integration, including selection and incremental sync cursors.
- `Workflow` reads and updates scheduled jobs and their execution history.
- `CalendarEvent` persists normalized calendar event records.
- `TodoTask` persists normalized task records.
- `HealthMetric` reads normalized sleep and weight records.

The calendar, todo, and health models use the shared `data_records` table.
Those models specialize inherited methods to filter by `record_type`, map
JSON payloads to domain attributes, and apply the common record contract. Use
their inherited CRUD methods (`create`, `find`, `where`, `update`, and
type-scoped `delete`) so the common shape and type filtering are preserved.
Health reads use `HealthMetric.all()` and group records by `record_type` at the
call site. More involved joins and workflow summaries use the shared raw query
API rather than adding one-off read methods to each model.

## Model conventions

- Keep model methods focused on persistence and domain rules; UI formatting
  belongs in the renderer layer.
- Use `validate()` for invariants that must hold whenever a model is saved.
  Throw a clear error for a useful message.
- Keep SQL parameterized for values. Table and column identifiers come from
  model definitions, not user input.
- Store provider-specific payload details in JSON only where the normalized
  record contract calls for them; expose common fields consistently.
- Transactions are synchronous because the SQLite driver and this API are
  synchronous. Do not `await` inside a transaction callback.
