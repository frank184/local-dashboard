const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const builtInPlugins = ['calendar', 'todos', 'health', 'finance', 'fitness'].map((id) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, '../plugins', id, 'manifest.json'), 'utf8')));
const localCalendarModel = JSON.parse(fs.readFileSync(path.join(__dirname, '../plugins/calendar/local-calendars.json'), 'utf8'));
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

  if (version < 11) db.exec(`
    BEGIN;
    ALTER TABLE integration_calendars ADD COLUMN display_label TEXT;
    PRAGMA user_version = 11;
    COMMIT;
  `);

  if (version < 12) {
    const calendarContract = db.prepare("SELECT schema_json FROM data_contracts WHERE contract_id = 'calendar_events' AND version = 2").get();
    if (calendarContract) {
      const schema = JSON.parse(calendarContract.schema_json);
      Object.assign(schema.fields, { recurrenceRule: 'string', recurrenceExceptions: 'object', recurringEventId: 'string', fitnessSeriesId: 'string', fitnessRoutineId: 'string', fitnessWeekday: 'string' });
      db.prepare("UPDATE data_contracts SET schema_json = ? WHERE contract_id = 'calendar_events' AND version = 2").run(JSON.stringify(schema));
    }
    db.exec('PRAGMA user_version = 12;');
  }

  if (version < 13) {
    db.exec(`
      UPDATE data_records
      SET payload_json = json_set(payload_json, '$.title', substr(json_extract(payload_json, '$.title'), 10))
      WHERE record_type = 'calendar_events'
        AND json_extract(payload_json, '$.calendarId') = 'local-fitness'
        AND json_extract(payload_json, '$.title') LIKE 'Workout: %';
      PRAGMA user_version = 13;
    `);
  }

  if (version < 14) {
    db.exec(`
      BEGIN;
      CREATE TABLE IF NOT EXISTS app_settings (
        setting_key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      PRAGMA user_version = 14;
      COMMIT;
    `);
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
    db.prepare('UPDATE plugins SET manifest_json = ?, icon = ? WHERE id = ?').run(JSON.stringify(plugin), plugin.icon, plugin.id);
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
    VALUES ('finance_transactions', 2, 'personal-finance', ?)`).run(JSON.stringify({ type: 'object', fields: {
    amount: 'number', currency: 'string', direction: 'income-or-expense', merchant: 'string', category: 'string', postedAt: 'date-time',
    sourceName: 'string', sourceFileName: 'string', sourceRowNumber: 'number', importBatchId: 'string', importFingerprint: 'sha256', accountLabel: 'string',
  } }));
  db.prepare(`INSERT OR IGNORE INTO data_contracts (contract_id, version, domain_id, schema_json)
    VALUES ('calendar_events', 2, 'personal-productivity', ?)`).run(JSON.stringify({ type: 'object', fields: {
    title: 'string', startAt: 'date-time-or-date', endAt: 'date-time-or-date', location: 'string', description: 'string', calendarId: 'string',
    calendarName: 'string', source: 'string', sourceName: 'string', sourceAccount: 'string', allDay: 'boolean', timezone: 'string',
    iCalUID: 'string', htmlLink: 'string', webLink: 'string', recurrenceRule: 'string', recurrenceExceptions: 'object', recurringEventId: 'string',
    fitnessSeriesId: 'string', fitnessRoutineId: 'string', fitnessWeekday: 'string',
  } }));
  const insertCalendarPlugin = db.prepare(`UPDATE plugins SET description = ?, icon = ? WHERE id = ? AND description = ''`);
  for (const plugin of builtInPlugins) insertCalendarPlugin.run(plugin.description, plugin.icon, plugin.id);

  const financeSeedVersion = db.prepare("SELECT value FROM app_meta WHERE key = 'starter-finance-ledger-v1'").get();
  if (!financeSeedVersion) {
    const insertFinanceSample = db.prepare(`INSERT OR IGNORE INTO data_records
      (id, domain_id, record_type, contract_version, source_plugin_id, external_id, occurred_at, payload_json)
      VALUES (?, 'personal-finance', 'finance_transactions', 1, 'finance', ?, ?, ?)`);
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    const merchants = [
      ['Northstar Market', 'Groceries', -84.26], ['Maple & Rye', 'Dining', -28.40],
      ['Metro Transit', 'Transport', -3.35], ['Juniper Coffee', 'Dining', -6.75],
      ['Lakeside Pharmacy', 'Health', -18.90], ['Streamline', 'Subscriptions', -12.99],
      ['Harbour Books', 'Shopping', -24.50], ['Pine Street Market', 'Groceries', -63.18],
      ['Studio North', 'Home', -46.00], ['City Hydro', 'Bills', -74.62],
      ['Corner Table', 'Dining', -41.35], ['Northstar Market', 'Groceries', -92.14],
      ['Maple & Rye', 'Dining', -19.80], ['Monthly pay', 'Income', 3420.00],
      ['Metro Transit', 'Transport', -3.35], ['Goodday Market', 'Groceries', -37.60],
      ['Petal & Stem', 'Gifts', -21.00], ['Cloud Storage', 'Subscriptions', -3.49],
      ['Bike repair', 'Transport', -58.00], ['Juniper Coffee', 'Dining', -5.80],
      ['Pine Street Market', 'Groceries', -78.23], ['Neighbourhood Cinema', 'Leisure', -32.00],
      ['Cellar Door', 'Dining', -54.70], ['Water bill', 'Bills', -39.16],
      ['Northstar Market', 'Groceries', -52.43], ['Design project', 'Income', 460.00],
      ['Maple & Rye', 'Dining', -34.20], ['Metro Transit', 'Transport', -3.35],
      ['Home Supply Co.', 'Home', -86.45], ['Juniper Coffee', 'Dining', -7.10],
      ['Goodday Market', 'Groceries', -44.95], ['Streamline', 'Subscriptions', -12.99],
      ['River Park Market', 'Groceries', -71.38], ['Neighbourhood Books', 'Shopping', -18.25],
      ['Monthly pay', 'Income', 3420.00], ['Corner Table', 'Dining', -25.60],
      ['City Hydro', 'Bills', -68.30], ['Northstar Market', 'Groceries', -58.70],
      ['Weekend train', 'Transport', -22.50], ['Petal & Stem', 'Gifts', -17.00],
      ['Maple & Rye', 'Dining', -39.40], ['Pine Street Market', 'Groceries', -88.62],
      ['Annual interest', 'Income', 14.82], ['Lakeside Pharmacy', 'Health', -12.40],
      ['Cloud Storage', 'Subscriptions', -3.49], ['Home Supply Co.', 'Home', -33.90],
      ['Juniper Coffee', 'Dining', -8.25], ['Goodday Market', 'Groceries', -48.72],
      ['Studio North', 'Home', -52.00], ['Metro Transit', 'Transport', -3.35],
      ['Corner Table', 'Dining', -31.65], ['Northstar Market', 'Groceries', -66.19],
      ['Monthly pay', 'Income', 3420.00], ['River Park Market', 'Groceries', -39.80],
      ['Streamline', 'Subscriptions', -12.99], ['Harbour Books', 'Shopping', -29.95],
      ['Maple & Rye', 'Dining', -47.20], ['City Hydro', 'Bills', -71.05],
      ['Pine Street Market', 'Groceries', -57.34], ['Metro Transit', 'Transport', -3.35],
    ];
    // Irregular spacing keeps the sample ledger believable without filling every day.
    const gaps = [1, 2, 1, 4, 2, 3, 1, 5, 2, 2, 6, 1, 3, 2, 4];
    let age = 0;
    const dated = merchants.map((entry, index) => {
      const date = new Date(today.getTime() - age * 86400000);
      age += gaps[index % gaps.length];
      return { entry, date };
    }).reverse();
    const categoryPlans = { Groceries: 620, Dining: 360, Transport: 180, Bills: 430, Home: 310, Subscriptions: 95, Health: 140, Shopping: 240, Leisure: 180, Gifts: 110 };
    dated.forEach(({ entry: [merchant, category, amount], date }, index) => {
      const day = localDayKey(date);
      const payload = { amount: Number(Math.abs(amount).toFixed(2)), currency: 'CAD', direction: amount > 0 ? 'income' : 'expense', merchant, category, postedAt: `${day}T12:00:00`, sourceName: 'Local sample' };
      if (index === 0) payload.categoryPlans = categoryPlans;
      insertFinanceSample.run(`finance-demo-${String(index + 1).padStart(3, '0')}`, `sample-finance-${index + 1}`, `${day}T12:00:00`, JSON.stringify(payload));
    });
    db.prepare("INSERT INTO app_meta (key, value) VALUES ('starter-finance-ledger-v1', '1')").run();
  }
  db.prepare(`INSERT OR IGNORE INTO workflows
    (id, plugin_id, name, trigger_type, definition_json, enabled)
    VALUES (?, 'finance', ?, 'manual', ?, 1)`).run(
    'workflow-finance-statement-import',
    'Import a bank statement',
    JSON.stringify({ jobType: 'local_data_pipeline', providerId: 'finance-statement-csv', pipelineVersion: 1,
      localOnly: true, stages: ['select_file', 'parse_csv', 'map_columns', 'preview_rows', 'normalize', 'deduplicate', 'commit_records'] }),
  );

  // One-time calendar layout examples. These are ordinary local events so they
  // can be opened, edited, or deleted like any other starter event.
  const allDaySeedVersion = db.prepare("SELECT value FROM app_meta WHERE key = 'starter-calendar-all-day-v1'").get();
  if (!allDaySeedVersion) {
    const monday = new Date();
    monday.setHours(0, 0, 0, 0);
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    const allDayExamples = [
      ['plan-week', 0, 'Plan the week', 'personal', 'blue'],
      ['project-milestone', 2, 'Project milestone', 'milestone', 'orange'],
      ['no-meetings', 4, 'No meetings', 'focus', 'purple'],
    ];
    const addAllDayEvent = db.prepare(`INSERT OR IGNORE INTO data_records
      (id, domain_id, record_type, source_plugin_id, external_id, occurred_at, payload_json)
      VALUES (?, 'personal-productivity', 'calendar_events', 'calendar', ?, ?, ?)`);
    for (const [id, offset, title, category, color] of allDayExamples) {
      const date = new Date(monday);
      date.setDate(date.getDate() + offset);
      const day = localDayKey(date);
      const recordId = `event-${id}`;
      addAllDayEvent.run(recordId, id, day, JSON.stringify({
        title,
        detail: 'Sample all-day event',
        category,
        startAt: day,
        endAt: day,
        allDay: true,
        color,
      }));
    }
    db.prepare("INSERT INTO app_meta (key, value) VALUES ('starter-calendar-all-day-v1', '1')").run();
  }

  // Normalize legacy sample metadata before adding calendar membership.
  const calendarCategorySeed = db.prepare("SELECT value FROM app_meta WHERE key = 'starter-calendar-event-categories-v1'").get();
  if (!calendarCategorySeed) {
    const update = db.prepare(`UPDATE data_records SET payload_json = json_set(payload_json, '$.category', ?, '$.color', ?)
      WHERE source_plugin_id = 'calendar' AND external_id = ? AND record_type = 'calendar_events'`);
    for (const [externalId, category, color] of [
      ['plan-week', 'planning', 'blue'], ['project-milestone', 'milestone', 'orange'], ['no-meetings', 'focus', 'purple'],
      ['walk', 'routine', 'green'], ['focus', 'focus', 'purple'], ['lunch', 'meeting', 'blue'], ['workout', 'routine', 'teal'],
    ]) update.run(category, color, externalId);
    db.prepare("INSERT INTO app_meta (key, value) VALUES ('starter-calendar-event-categories-v1', '1')").run();
  }

  const localCalendarSeed = db.prepare("SELECT value FROM app_meta WHERE key = 'starter-local-calendar-account-v1'").get();
  if (!localCalendarSeed) {
    const calendarByEvent = [
      ['plan-week', 'local', 'planning'], ['project-milestone', 'local-projects', 'milestone'], ['no-meetings', 'local', 'focus'],
      ['walk', 'local-health', 'routine'], ['focus', 'local', 'focus'], ['lunch', 'local', 'meeting'], ['workout', 'local-fitness', 'routine'],
    ];
    const updateEventCalendar = db.prepare(`UPDATE data_records SET payload_json = json_set(payload_json,
      '$.calendarId', ?, '$.calendarName', ?, '$.calendarColor', ?, '$.accountId', 'local-dashboard', '$.accountName', 'Local Dashboard', '$.category', ?)
      WHERE source_plugin_id = 'calendar' AND external_id = ? AND record_type = 'calendar_events'`);
    for (const [externalId, calendarId, category] of calendarByEvent) {
      const calendar = localCalendarModel.calendars.find((item) => item.id === calendarId);
      if (calendar) updateEventCalendar.run(calendar.id, calendar.name, calendar.color, category, externalId);
    }

    const insertLocalCalendarEvent = db.prepare(`INSERT OR IGNORE INTO data_records
      (id, domain_id, record_type, source_plugin_id, external_id, occurred_at, payload_json)
      VALUES (?, 'personal-productivity', 'calendar_events', 'calendar', ?, ?, ?)`);
    const atDay = (days) => { const date = new Date(); date.setHours(0, 0, 0, 0); date.setDate(date.getDate() + days); return localDayKey(date); };
    const samples = [
      ['fitness-run', 'local-fitness', 1, 'Morning run', 'routine', '07:30:00', 45],
      ['finance-rent', 'local-finance', 5, 'Rent due', 'reminder', null, null],
      ['health-checkup', 'local-health', 8, 'Annual check-up', 'appointment', '10:00:00', 45],
      ['goals-review', 'local-goals', 3, 'Monthly goals review', 'milestone', '17:00:00', 30],
    ];
    for (const [id, calendarId, days, title, category, time, duration] of samples) {
      const calendar = localCalendarModel.calendars.find((item) => item.id === calendarId);
      const day = atDay(days);
      const startAt = time ? `${day}T${time}` : day;
      const endAt = time ? new Date(new Date(startAt).getTime() + duration * 60_000).toISOString() : day;
      const payload = {
        title, detail: 'Local calendar example', category, startAt, endAt, allDay: !time,
        calendarId, calendarName: calendar.name, calendarColor: calendar.color,
        accountId: localCalendarModel.account.id, accountName: localCalendarModel.account.name,
        color: calendar.color,
      };
      insertLocalCalendarEvent.run(`event-local-${id}`, `local-${id}`, startAt, JSON.stringify(payload));
    }
    db.prepare("INSERT INTO app_meta (key, value) VALUES ('starter-local-calendar-account-v1', '1')").run();
  }

  const semanticCalendarCategories = db.prepare("SELECT value FROM app_meta WHERE key = 'starter-calendar-semantic-categories-v2'").get();
  if (!semanticCalendarCategories) {
    const updateCategory = db.prepare(`UPDATE data_records SET payload_json = json_set(payload_json, '$.category', ?)
      WHERE source_plugin_id = 'calendar' AND external_id = ? AND record_type = 'calendar_events'`);
    for (const [externalId, category] of [
      ['plan-week', 'planning'], ['project-milestone', 'milestone'], ['no-meetings', 'focus'],
      ['walk', 'routine'], ['focus', 'focus'], ['lunch', 'meeting'], ['workout', 'routine'],
      ['local-fitness-run', 'routine'], ['local-finance-rent', 'reminder'],
      ['local-health-checkup', 'appointment'], ['local-goals-review', 'milestone'],
    ]) updateCategory.run(category, externalId);
    db.prepare("INSERT INTO app_meta (key, value) VALUES ('starter-calendar-semantic-categories-v2', '1')").run();
  }

  const neutralCalendarCategories = db.prepare("SELECT value FROM app_meta WHERE key = 'calendar-neutral-categories-v3'").get();
  if (!neutralCalendarCategories) {
    db.prepare(`UPDATE data_records SET payload_json = json_set(payload_json, '$.category', 'general')
      WHERE source_plugin_id = 'calendar' AND record_type = 'calendar_events'
        AND json_extract(payload_json, '$.category') = 'personal'`).run();
    db.prepare(`UPDATE data_records SET payload_json = json_set(payload_json, '$.category', 'planning')
      WHERE source_plugin_id = 'calendar' AND external_id = 'plan-week' AND record_type = 'calendar_events'`).run();
    db.prepare("INSERT INTO app_meta (key, value) VALUES ('calendar-neutral-categories-v3', '1')").run();
  }

  const healthSeedVersion = db.prepare("SELECT value FROM app_meta WHERE key = 'starter-health-trends-v1'").get();
  if (!healthSeedVersion) {
    // Replace the original 14-day demo rows with a longer, deliberately irregular
    // sample history. These are clearly marked as local sample data in the UI.
    db.prepare(`DELETE FROM data_records WHERE source_plugin_id IS NULL AND (
      id GLOB 'sleep-[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' OR
      id GLOB 'weight-[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    )`).run();
    const insertHealthSample = db.prepare(`INSERT OR IGNORE INTO data_records
      (id, domain_id, record_type, contract_version, source_plugin_id, external_id, occurred_at, payload_json)
      VALUES (?, 'personal-health', ?, 1, 'health', ?, ?, ?)`);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const weightGaps = [5, 8, 6, 11, 7, 9, 4, 13, 6, 10];
    const weightDates = [];
    let age = 0;
    for (let index = 0; index < 70; index += 1) {
      weightDates.push(new Date(today.getTime() - age * 86400000));
      age += weightGaps[index % weightGaps.length];
    }
    weightDates.reverse();
    weightDates.forEach((date, index) => {
      const progress = index / (weightDates.length - 1);
      const lossProgress = Math.min(progress / 0.7, 1);
      const reboundProgress = Math.max(0, (progress - 0.86) / 0.14);
      const kilograms = 104.3 - 15.2 * lossProgress + 3.0 * reboundProgress
        + Math.sin(index * 1.71) * 0.75 + Math.cos(index * 0.57) * 0.38;
      const bodyFatPercent = 31 - 11.6 * lossProgress + 1.6 * reboundProgress
        + Math.sin(index * 1.31) * 0.8 + Math.cos(index * 0.43) * 0.35;
      const day = localDayKey(date);
      const payload = { kilograms: Number(kilograms.toFixed(2)), bodyFatPercent: Number(bodyFatPercent.toFixed(1)), sourceName: 'Local sample' };
      insertHealthSample.run(`health-demo-weight-${day}`, 'health_weight', `sample-weight-${day}`, `${day}T08:00:00`, JSON.stringify(payload));
    });

    const sleepGaps = [1, 2, 1, 1, 3, 1, 2, 1, 2, 1, 4, 1];
    const sleepDates = [];
    age = 0;
    for (let index = 0; index < 52; index += 1) {
      sleepDates.push(new Date(today.getTime() - age * 86400000));
      age += sleepGaps[index % sleepGaps.length];
    }
    sleepDates.reverse();
    sleepDates.forEach((date, index) => {
      const progress = index / (sleepDates.length - 1);
      const scheduleProgress = Math.min(progress / 0.72, 1);
      const reboundProgress = Math.max(0, (progress - 0.82) / 0.18);
      const bedtimeHour = 3.2 - 1.9 * scheduleProgress + 0.35 * reboundProgress + Math.sin(index * 1.8) * 0.75;
      const durationHours = 6.05 + 0.55 * progress + Math.sin(index * 2.4) * 0.75 + Math.cos(index * 0.7) * 0.35;
      const wakeHour = ((bedtimeHour + durationHours) % 24 + 24) % 24;
      const efficiency = Math.max(78, Math.min(98, 87 + 6 * progress + Math.sin(index * 1.37) * 5));
      const day = localDayKey(date);
      const payload = {
        durationHours: Number(Math.max(4.5, Math.min(9, durationHours)).toFixed(2)),
        bedtimeHour: Number((((bedtimeHour % 24) + 24) % 24).toFixed(2)),
        wakeHour: Number(wakeHour.toFixed(2)),
        efficiency: Number(efficiency.toFixed(1)),
        qualityScore: Number(efficiency.toFixed(1)),
        sourceName: 'Local sample',
      };
      insertHealthSample.run(`health-demo-sleep-${day}`, 'health_sleep', `sample-sleep-${day}`, `${day}T23:00:00`, JSON.stringify(payload));
    });
    db.prepare("INSERT INTO app_meta (key, value) VALUES ('starter-health-trends-v1', '1')").run();
  }

  if (seedVersion) return;

  const insertRecord = db.prepare(`INSERT OR IGNORE INTO data_records
    (id, domain_id, record_type, source_plugin_id, external_id, occurred_at, payload_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const add = (id, domain, type, source, externalId, occurredAt, payload) =>
    insertRecord.run(id, domain, type, source, externalId, occurredAt, JSON.stringify(payload));

  const events = [
    ['walk', `${localDayKey(new Date())}T08:30:00`, 'Morning walk', '30 minutes · Health plan', 'routine', 'local-health'],
    ['focus', `${localDayKey(new Date())}T10:00:00`, 'Focus block', 'Work · 90 minutes', 'focus', 'local'],
    ['lunch', `${localDayKey(new Date())}T13:00:00`, 'Lunch with Alex', 'Personal · 1 hour', 'meeting', 'local'],
    ['workout', `${localDayKey(new Date())}T17:30:00`, 'Strength workout', '45 minutes · Health plan', 'routine', 'local-fitness'],
  ];
  for (const [id, time, title, detail, category, calendarId] of events) {
    const calendar = localCalendarModel.calendars.find((item) => item.id === calendarId);
    add(`event-${id}`, 'personal-productivity', 'calendar_events', 'calendar', id, time, {
      title, detail, category, color: calendar.color,
      calendarId: calendar.id, calendarName: calendar.name, calendarColor: calendar.color,
      accountId: localCalendarModel.account.id, accountName: localCalendarModel.account.name,
    });
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
