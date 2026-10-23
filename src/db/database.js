const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const builtInPlugins = ['calendar', 'todos', 'health'].map((id) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, '../plugins', id, 'manifest.json'), 'utf8')));
const bundledIntegrations = ['google-calendar', 'outlook-calendar', 'fitbit'].map((id) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, '../integrations', id, 'manifest.json'), 'utf8')));
const connectorPlugins = [
  { id: 'apple-calendar-connector', name: 'Apple Calendar connector', domainId: 'personal-productivity', icon: 'calendar-days' },
  { id: 'google-health-api-connector', name: 'Google Health API connector', domainId: 'personal-health', icon: 'activity' },
  { id: 'health-connect-connector', name: 'Health Connect (Android) connector', domainId: 'personal-health', icon: 'activity' },
  { id: 'withings-connector', name: 'Withings connector', domainId: 'personal-health', icon: 'scale' },
  { id: 'strava-connector', name: 'Strava connector', domainId: 'personal-health', icon: 'activity' },
];

function openDatabase(userDataPath) {
  fs.mkdirSync(userDataPath, { recursive: true });
  const db = new DatabaseSync(path.join(userDataPath, 'local-dashboard.sqlite'));
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  migrate(db);
  seedBuiltIns(db);
  return db;
}

function migrate(db) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version < 1) db.exec(`
    BEGIN;
    CREATE TABLE domains (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE plugins (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      version TEXT NOT NULL,
      domain_id TEXT NOT NULL REFERENCES domains(id),
      kind TEXT NOT NULL CHECK (kind IN ('source', 'feature', 'orchestration')),
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      installed_at TEXT NOT NULL DEFAULT (datetime('now')),
      manifest_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE data_records (
      id TEXT PRIMARY KEY,
      domain_id TEXT NOT NULL REFERENCES domains(id),
      record_type TEXT NOT NULL,
      source_plugin_id TEXT REFERENCES plugins(id),
      external_id TEXT,
      occurred_at TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (source_plugin_id, external_id)
    );
    CREATE INDEX data_records_domain_time ON data_records(domain_id, occurred_at);
    CREATE INDEX data_records_type_time ON data_records(record_type, occurred_at);
    CREATE TABLE plugin_state (
      plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
      state_key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (plugin_id, state_key)
    );
    CREATE TABLE workflows (
      id TEXT PRIMARY KEY,
      plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      trigger_type TEXT NOT NULL CHECK (trigger_type IN ('schedule', 'event', 'manual')),
      definition_json TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE workflow_runs (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
      started_at TEXT,
      finished_at TEXT,
      result_json TEXT,
      error_text TEXT
    );
    CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    PRAGMA user_version = 1;
    COMMIT;
  `);

  if (version < 2) db.exec(`
    BEGIN;
    ALTER TABLE plugins ADD COLUMN description TEXT NOT NULL DEFAULT '';
    ALTER TABLE plugins ADD COLUMN icon TEXT NOT NULL DEFAULT 'blocks';
    ALTER TABLE plugins ADD COLUMN installed INTEGER NOT NULL DEFAULT 1 CHECK (installed IN (0, 1));
    CREATE TABLE integrations (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      account_label TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'setup_required' CHECK (status IN ('connected', 'setup_required', 'paused', 'error')),
      plugin_id TEXT NOT NULL REFERENCES plugins(id),
      sync_workflow_id TEXT REFERENCES workflows(id),
      config_json TEXT NOT NULL DEFAULT '{}',
      last_sync_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    ALTER TABLE data_records ADD COLUMN integration_id TEXT REFERENCES integrations(id);
    CREATE INDEX integrations_provider ON integrations(provider_id, status);
    PRAGMA user_version = 2;
    COMMIT;
  `);

  if (version < 3) db.exec(`
    BEGIN;
    ALTER TABLE data_records ADD COLUMN contract_version INTEGER NOT NULL DEFAULT 1;
    CREATE TABLE data_contracts (
      contract_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      domain_id TEXT NOT NULL REFERENCES domains(id),
      schema_json TEXT NOT NULL,
      registered_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (contract_id, version)
    );
    UPDATE data_records SET record_type = 'calendar_events' WHERE record_type = 'calendar.event';
    UPDATE data_records SET record_type = 'todo_tasks' WHERE record_type = 'todo.task';
    UPDATE data_records SET record_type = 'health_sleep' WHERE record_type = 'health.sleep_session';
    UPDATE data_records SET record_type = 'health_weight' WHERE record_type = 'health.weight_measurement';
    CREATE INDEX data_records_contract_time ON data_records(record_type, contract_version, occurred_at);
    PRAGMA user_version = 3;
    COMMIT;
  `);

  if (version < 4) db.exec(`
    BEGIN;
    ALTER TABLE integrations ADD COLUMN secret_blob TEXT;
    PRAGMA user_version = 4;
    COMMIT;
  `);

  if (version < 5) db.exec(`
    BEGIN;
    ALTER TABLE workflows ADD COLUMN integration_id TEXT REFERENCES integrations(id) ON DELETE SET NULL;
    ALTER TABLE workflows ADD COLUMN next_run_at TEXT;
    ALTER TABLE workflows ADD COLUMN last_run_at TEXT;
    CREATE INDEX workflows_due ON workflows(enabled, next_run_at);
    PRAGMA user_version = 5;
    COMMIT;
  `);

  // Some early local databases reached version 2 before this column was
  // included in the integrations table definition. Repair those databases
  // without replacing or rebuilding any user data.
  if (version < 6) {
    const integrationColumns = new Set(db.prepare('PRAGMA table_info(integrations)').all().map((column) => column.name));
    db.exec('BEGIN;');
    try {
      if (!integrationColumns.has('sync_workflow_id')) {
        db.exec('ALTER TABLE integrations ADD COLUMN sync_workflow_id TEXT REFERENCES workflows(id);');
      }
      db.exec('PRAGMA user_version = 6; COMMIT;');
    } catch (error) {
      db.exec('ROLLBACK;');
      throw error;
    }
  }

  if (version < 7) db.exec(`
    BEGIN;
    CREATE TABLE integration_calendars (
      id TEXT PRIMARY KEY,
      integration_id TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
      external_calendar_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      timezone TEXT,
      color TEXT,
      selected INTEGER NOT NULL DEFAULT 1 CHECK (selected IN (0, 1)),
      sync_token TEXT,
      last_sync_at TEXT,
      UNIQUE (integration_id, external_calendar_id)
    );
    CREATE INDEX integration_calendars_selected ON integration_calendars(integration_id, selected);
    PRAGMA user_version = 7;
    COMMIT;
  `);

  if (version < 8) db.exec(`
    BEGIN;
    ALTER TABLE integration_calendars ADD COLUMN sync_window_start TEXT;
    ALTER TABLE integration_calendars ADD COLUMN sync_window_end TEXT;
    PRAGMA user_version = 8;
    COMMIT;
  `);

  if (version < 9) db.exec(`
    BEGIN;
    PRAGMA user_version = 9;
    COMMIT;
  `);

  if (version < 10) {
    const calendarContract = db.prepare("SELECT schema_json FROM data_contracts WHERE contract_id = 'calendar_events' AND version = 2").get();
    if (calendarContract) {
      const schema = JSON.parse(calendarContract.schema_json);
      schema.fields.startAt = 'date-time-or-date';
      schema.fields.endAt = 'date-time-or-date';
      db.prepare("UPDATE data_contracts SET schema_json = ? WHERE contract_id = 'calendar_events' AND version = 2").run(JSON.stringify(schema));
    }
    db.exec('PRAGMA user_version = 10;');
  }
}

function seedBuiltIns(db) {
  const seedVersion = db.prepare("SELECT value FROM app_meta WHERE key = 'starter-data-v1'").get();
  const insertDomain = db.prepare('INSERT OR IGNORE INTO domains (id, label, description) VALUES (?, ?, ?)');
  insertDomain.run('personal-productivity', 'Personal productivity', 'Planning, tasks, and time');
  insertDomain.run('personal-health', 'Personal health', 'Health measurements and activity');
  insertDomain.run('personal-finance', 'Personal finance', 'Money and household finances');

  const insertPlugin = db.prepare(`INSERT OR IGNORE INTO plugins
    (id, name, version, domain_id, kind, manifest_json, description, icon, installed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const plugin of builtInPlugins) {
    insertPlugin.run(plugin.id, plugin.name, plugin.version, plugin.domainId, plugin.kind, JSON.stringify(plugin), plugin.description, plugin.icon, 1);
    db.prepare('UPDATE plugins SET manifest_json = ? WHERE id = ?').run(JSON.stringify(plugin), plugin.id);
  }
  for (const plugin of connectorPlugins) {
    insertPlugin.run(plugin.id, plugin.name, '0.1.0', plugin.domainId, 'source', JSON.stringify({ connector: plugin.id }), 'Connector adapter', plugin.icon, 0);
  }
  for (const integration of bundledIntegrations) {
    insertPlugin.run(integration.pluginId, integration.pluginName, '0.1.0', integration.domainId, 'source', JSON.stringify(integration), 'Connector adapter', integration.icon, 0);
    db.prepare('UPDATE plugins SET manifest_json = ? WHERE id = ?').run(JSON.stringify(integration), integration.pluginId);
  }
  const contracts = [
    ['calendar_events', 'personal-productivity', { title: 'string', startAt: 'date-time', endAt: 'date-time', location: 'string', description: 'string', calendarId: 'string' }],
    ['todo_tasks', 'personal-productivity', { title: 'string', detail: 'string', category: 'string', completed: 'boolean', dueAt: 'date-time' }],
    ['health_sleep', 'personal-health', { durationHours: 'number', sleepStages: 'array', qualityScore: 'number' }],
    ['health_weight', 'personal-health', { kilograms: 'number', bodyFatPercent: 'number' }],
    ['finance_transactions', 'personal-finance', { amount: 'number', currency: 'string', direction: 'string', merchant: 'string', category: 'string', postedAt: 'date-time' }],
  ];
  const insertContract = db.prepare(`INSERT OR IGNORE INTO data_contracts (contract_id, version, domain_id, schema_json)
    VALUES (?, 1, ?, ?)`);
  for (const [id, domainId, fields] of contracts) {
    insertContract.run(id, domainId, JSON.stringify({ type: 'object', fields }));
  }
  db.prepare(`INSERT OR IGNORE INTO data_contracts (contract_id, version, domain_id, schema_json)
    VALUES ('calendar_events', 2, 'personal-productivity', ?)`).run(JSON.stringify({ type: 'object', fields: {
    title: 'string', startAt: 'date-time-or-date', endAt: 'date-time-or-date', location: 'string', description: 'string', calendarId: 'string',
    calendarName: 'string', source: 'string', sourceName: 'string', sourceAccount: 'string', allDay: 'boolean', timezone: 'string',
    iCalUID: 'string', htmlLink: 'string', webLink: 'string',
  } }));
  const insertCalendarPlugin = db.prepare(`UPDATE plugins SET description = ?, icon = ? WHERE id = ? AND description = ''`);
  for (const plugin of builtInPlugins) insertCalendarPlugin.run(plugin.description, plugin.icon, plugin.id);

  // One-time calendar layout examples. These are ordinary local events so they
  // can be opened, edited, or deleted like any other starter event.
  const allDaySeedVersion = db.prepare("SELECT value FROM app_meta WHERE key = 'starter-calendar-all-day-v1'").get();
  if (!allDaySeedVersion) {
    const monday = new Date();
    monday.setHours(0, 0, 0, 0);
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    const allDayExamples = [
      ['plan-week', 0, 'Plan the week', 'blue'],
      ['project-milestone', 2, 'Project milestone', 'purple'],
      ['no-meetings', 4, 'No meetings', 'orange'],
    ];
    const addAllDayEvent = db.prepare(`INSERT OR IGNORE INTO data_records
      (id, domain_id, record_type, source_plugin_id, external_id, occurred_at, payload_json)
      VALUES (?, 'personal-productivity', 'calendar_events', 'calendar', ?, ?, ?)`);
    for (const [id, offset, title, color] of allDayExamples) {
      const date = new Date(monday);
      date.setDate(date.getDate() + offset);
      const day = localDayKey(date);
      const recordId = `event-${id}`;
      addAllDayEvent.run(recordId, id, day, JSON.stringify({
        title,
        detail: 'Sample all-day event',
        category: 'personal',
        startAt: day,
        endAt: day,
        allDay: true,
        color,
      }));
    }
    db.prepare("INSERT INTO app_meta (key, value) VALUES ('starter-calendar-all-day-v1', '1')").run();
  }

  if (seedVersion) return;

  const insertRecord = db.prepare(`INSERT OR IGNORE INTO data_records
    (id, domain_id, record_type, source_plugin_id, external_id, occurred_at, payload_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const add = (id, domain, type, source, externalId, occurredAt, payload) =>
    insertRecord.run(id, domain, type, source, externalId, occurredAt, JSON.stringify(payload));

  const events = [
    ['walk', `${localDayKey(new Date())}T08:30:00`, 'Morning walk', '30 minutes · Health plan', 'personal-health'],
    ['focus', `${localDayKey(new Date())}T10:00:00`, 'Focus block', 'Work · 90 minutes', null],
    ['lunch', `${localDayKey(new Date())}T13:00:00`, 'Lunch with Alex', 'Personal · 1 hour', null],
    ['workout', `${localDayKey(new Date())}T17:30:00`, 'Strength workout', '45 minutes · Health plan', 'personal-health'],
  ];
  for (const [id, time, title, detail, domain] of events) {
    add(`event-${id}`, 'personal-productivity', 'calendar_events', 'calendar', id, time, { title, detail, category: domain || 'personal' });
  }

  const tasks = [
    ['walk', 'Take a morning walk', 'Health plan · Due 9:00 AM', 'health', `${localDayKey(new Date())}T09:00:00`, false],
    ['groceries', 'Pick up groceries', 'Personal · Due 12:30 PM', 'personal', `${localDayKey(new Date())}T12:30:00`, false],
    ['workout', 'Strength workout', 'Created from your weekly plan · Due 5:30 PM', 'health', `${localDayKey(new Date())}T17:30:00`, false],
    ['review', 'Review the week', 'Sunday · 15 minutes', 'personal', `${localDayKey(nextWeekday(new Date(), 0))}T12:00:00`, false],
    ['bedtime', 'Try a consistent bedtime', 'Health goal · Tomorrow', 'health', `${localDayKey(new Date(Date.now() + 86400000))}T21:00:00`, false],
  ];
  for (const [id, title, detail, category, dueAt, completed] of tasks) {
    add(`task-${id}`, 'personal-productivity', 'todo_tasks', 'todos', id, dueAt, { title, detail, category, completed });
  }

  const sleepHours = [6.8, 7.4, 7.9, 6.9, 7.7, 8.1, 7.2, 7.6, 6.7, 7.9, 8.2, 7.0, 7.8, 7.6];
  const weights = [73.2, 73.0, 73.1, 72.9, 72.8, 73.0, 72.7, 72.8, 72.6, 72.7, 72.5, 72.6, 72.3, 72.4];
  for (let index = 0; index < sleepHours.length; index += 1) {
    const dayDate = new Date(); dayDate.setDate(dayDate.getDate() - (sleepHours.length - 1 - index));
    const day = localDayKey(dayDate);
    add(`sleep-${day}`, 'personal-health', 'health_sleep', null, `sleep-${day}`, `${day}T23:00:00`, { durationHours: sleepHours[index] });
    add(`weight-${day}`, 'personal-health', 'health_weight', null, `weight-${day}`, `${day}T08:00:00`, { kilograms: weights[index] });
  }

  db.prepare("INSERT INTO app_meta (key, value) VALUES ('starter-data-v1', '1')").run();
}

function localDayKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function nextWeekday(date, weekday) {
  const next = new Date(date);
  const delta = (weekday - next.getDay() + 7) % 7 || 7;
  next.setDate(next.getDate() + delta);
  return next;
}

module.exports = { openDatabase };
