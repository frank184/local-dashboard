const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { openDatabase } = require('../src/db/database');
const {
  ApplicationRecord,
  CalendarEvent,
  HealthMetric,
  Integration,
  IntegrationCalendar,
  Plugin,
  TodoTask,
  Workflow,
} = require('../src/models');

test('models preserve the existing query output and provide basic record behavior', (t) => {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'local-dashboard-models-'));
  const db = openDatabase(tempDirectory);
  ApplicationRecord.connect(db);
  t.after(() => {
    ApplicationRecord.disconnect();
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  });

  assert.throws(() => new ApplicationRecord(), /abstract/);

  class ProbeRecord extends ApplicationRecord {
    static get tableName() { return 'app_meta'; }
    static get primaryKey() { return 'key'; }
    static get columns() { return ['key', 'value']; }
    validate() { if (!this.key || !this.value) throw new Error('key and value are required'); }
  }

  const probe = ProbeRecord.create({ key: 'model-crud-probe', value: 'created' });
  assert.equal(ProbeRecord.find(probe.key).value, 'created');
  probe.update({ value: 'saved' });
  assert.equal(ProbeRecord.find(probe.key).value, 'saved');
  assert.ok(ProbeRecord.all().some((record) => record.key === probe.key));
  assert.equal(ProbeRecord.update(probe.key, { value: 'updated' }).value, 'updated');
  assert.equal(ProbeRecord.find(probe.key).value, 'updated');
  assert.equal(ProbeRecord.find(probe.key).delete(), true);
  assert.equal(ProbeRecord.find(probe.key), null);
  assert.throws(() => ProbeRecord.transaction(() => {
    ProbeRecord.create({ key: 'model-rollback-probe', value: 'temporary' });
    throw new Error('rollback');
  }), /rollback/);
  assert.equal(ProbeRecord.find('model-rollback-probe'), null);

  // These are the result shapes returned by the old repository queries.
  const oldPluginListQuery = "SELECT id, name, version, domain_id, kind, enabled, installed, description, icon FROM plugins WHERE kind != 'source' ORDER BY name";
  const oldNavigationQuery = 'SELECT id, name, icon FROM plugins WHERE installed = 1 AND enabled = 1 ORDER BY installed_at, name';
  const oldIntegrationListQuery = `SELECT id, provider_id, display_name, account_label, status, plugin_id, sync_workflow_id, last_sync_at, config_json,
    secret_blob IS NOT NULL AS has_credentials,
    (SELECT COUNT(*) FROM integration_calendars c WHERE c.integration_id = integrations.id AND c.selected = 1) AS selected_calendar_count
    FROM integrations ORDER BY display_name, account_label`;
  const oldCalendarRecordsQuery = 'SELECT id, domain_id, record_type, contract_version, source_plugin_id, integration_id, external_id, occurred_at, payload_json FROM data_records WHERE record_type = ? ORDER BY occurred_at';
  assert.deepEqual(Plugin.where({ kind: { $ne: 'source' } }, { select: ['id', 'name', 'version', 'domain_id', 'kind', 'enabled', 'installed', 'description', 'icon'], orderBy: 'name' }).map((record) => record.toJSON()), db.prepare(oldPluginListQuery).all().map((row) => ({ ...row })));
  assert.deepEqual(Plugin.where({ installed: 1, enabled: 1 }, { select: ['id', 'name', 'icon'], orderBy: ['installed_at', 'name'] }).map((record) => record.toJSON()), db.prepare(oldNavigationQuery).all().map((row) => ({ ...row })));
  assert.deepEqual(ApplicationRecord.query(oldIntegrationListQuery), db.prepare(oldIntegrationListQuery).all().map((row) => ({ ...row })));
  assert.deepEqual(CalendarEvent.all().map((record) => record.toJSON()), db.prepare(oldCalendarRecordsQuery).all('calendar_events').map((row) => ({ ...row, ...JSON.parse(row.payload_json) })));
  assert.deepEqual(TodoTask.all().map((record) => record.toJSON()), db.prepare(oldCalendarRecordsQuery).all('todo_tasks').map((row) => ({ ...row, ...JSON.parse(row.payload_json) })));

  const oldHealthQuery = `SELECT id, domain_id, record_type, contract_version, source_plugin_id, integration_id, external_id, occurred_at, payload_json
    FROM data_records WHERE record_type = ? ORDER BY occurred_at`;
  const healthRecords = HealthMetric.all().map((record) => record.toJSON());
  assert.deepEqual({
    sleep: healthRecords.filter((record) => record.record_type === 'health_sleep'),
    weight: healthRecords.filter((record) => record.record_type === 'health_weight'),
  }, {
    sleep: db.prepare(oldHealthQuery).all('health_sleep').map((row) => ({ ...row, ...JSON.parse(row.payload_json) })),
    weight: db.prepare(oldHealthQuery).all('health_weight').map((row) => ({ ...row, ...JSON.parse(row.payload_json) })),
  });

  const oldWorkflowRowsQuery = `SELECT w.id, w.plugin_id, w.integration_id, w.name, w.trigger_type, w.definition_json, w.enabled, w.next_run_at, w.last_run_at,
      i.display_name AS integration_name, i.status AS integration_status
    FROM workflows w LEFT JOIN integrations i ON i.id = w.integration_id ORDER BY w.created_at DESC`;
  const oldWorkflowRows = db.prepare(oldWorkflowRowsQuery).all().map((row) => ({ ...row, definition: JSON.parse(row.definition_json) }));
  assert.deepEqual(ApplicationRecord.query(oldWorkflowRowsQuery).map((row) => ({ ...row, definition: JSON.parse(row.definition_json) })), oldWorkflowRows);

  const plugin = Plugin.create({ name: 'Model Plugin', domain_id: 'personal-productivity' });
  const pluginId = plugin.id;
  assert.ok(Plugin.find(pluginId));
  assert.ok(Plugin.update(pluginId, { name: 'Updated Model Plugin', domain_id: 'personal-productivity', enabled: 0 }));
  assert.equal(Plugin.find(pluginId).name, 'Updated Model Plugin');
  assert.equal(Plugin.uninstallPlugin(pluginId), true);
  assert.equal(Plugin.installPlugin(pluginId), true);
  assert.equal(ApplicationRecord.query('SELECT value_json FROM plugin_state WHERE plugin_id = ? AND state_key = ?', 'calendar', 'test-setting')[0], undefined);
  ApplicationRecord.execute(`INSERT INTO plugin_state (plugin_id, state_key, value_json, updated_at) VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(plugin_id, state_key) DO UPDATE SET value_json = excluded.value_json, updated_at = datetime('now')`, 'calendar', 'test-setting', JSON.stringify({ visible: true }));
  assert.deepEqual(JSON.parse(ApplicationRecord.query('SELECT value_json FROM plugin_state WHERE plugin_id = ? AND state_key = ?', 'calendar', 'test-setting')[0].value_json), { visible: true });

  const integration = Integration.create({
    provider_id: 'google-calendar', display_name: 'Google Calendar', account_label: 'Personal', plugin_id: 'google-calendar-connector',
  });
  const integrationId = integration.id;
  Integration.update(integrationId, { config_json: JSON.stringify({ clientId: 'test-client' }), secret_blob: 'encrypted-test-token', account_label: 'Personal', status: 'connected' });
  IntegrationCalendar.upsertAll([{ integration_id: integrationId, external_calendar_id: 'primary', summary: 'Primary', timezone: 'America/Toronto' }], {
    uniqueBy: ['integration_id', 'external_calendar_id'], updateColumns: ['summary', 'timezone', 'color'],
  });
  const workflowId = Integration.ensureCalendarSyncWorkflow(integrationId);
  assert.equal(Integration.find(integrationId).sync_workflow_id, workflowId);
  const calendarRows = IntegrationCalendar.where({ integration_id: integrationId }, { orderBy: 'summary' }).map((record) => record.toJSON());
  assert.equal(calendarRows[0].external_calendar_id, 'primary');
  const selectedCalendar = ApplicationRecord.query(`SELECT c.id, c.integration_id, c.external_calendar_id, c.summary, c.timezone, c.color, c.sync_token, c.sync_window_start, c.sync_window_end, i.account_label
    FROM integration_calendars c JOIN integrations i ON i.id = c.integration_id WHERE c.integration_id = ? AND c.selected = 1 ORDER BY c.summary`, integrationId)[0];
  assert.equal(selectedCalendar.external_calendar_id, 'primary');
  const integrationCalendarId = calendarRows[0].id;
  assert.ok(IntegrationCalendar.update(integrationCalendarId, { sync_token: 'cursor-1', sync_window_start: '2026-10-20', sync_window_end: '2026-10-27', last_sync_at: new Date().toISOString() }));
  assert.equal(ApplicationRecord.query(`SELECT sync_token FROM integration_calendars WHERE integration_id = ? AND selected = 1`, integrationId)[0].sync_token, 'cursor-1');
  assert.equal(Workflow.find(workflowId).definition.providerId, 'google-calendar');
  assert.ok(ApplicationRecord.query(oldWorkflowRowsQuery).some((workflow) => workflow.id === workflowId && workflow.integration_name === 'Google Calendar'));

  const importedEvent = { id: 'imported-event-1', externalId: 'google-event-1', occurredAt: '2026-10-25T11:00:00Z', payload: { title: 'Imported' } };
  CalendarEvent.upsertAll([{
    id: importedEvent.id, domain_id: 'personal-productivity', record_type: 'calendar_events', contract_version: 2,
    source_plugin_id: 'google-calendar-connector', integration_id: integrationId, external_id: importedEvent.externalId,
    occurred_at: importedEvent.occurredAt, payload_json: JSON.stringify(importedEvent.payload),
  }], { uniqueBy: ['source_plugin_id', 'external_id'], updateColumns: ['contract_version', 'integration_id', 'occurred_at', 'payload_json'] });
  assert.equal(CalendarEvent.all().some((event) => event.id === importedEvent.id && event.title === 'Imported'), true);
  assert.equal(CalendarEvent.deleteWhere({ integration_id: integrationId, source_plugin_id: 'google-calendar-connector', external_id: { $in: ['google-event-1'] } }), 1);

  const event = CalendarEvent.create({ title: 'Model event', startAt: '2026-10-25', endAt: '2026-10-25', allDay: true });
  const eventId = event.id;
  assert.equal(CalendarEvent.find(eventId).title, 'Model event');
  assert.ok(CalendarEvent.update(eventId, { title: 'Updated model event', startAt: '2026-10-26', endAt: '2026-10-26', allDay: true }));
  assert.equal(CalendarEvent.find(eventId).title, 'Updated model event');
  assert.equal(CalendarEvent.delete(eventId), true);

  const task = TodoTask.create({ title: 'Model task', dueAt: '2026-10-25T09:30' });
  const taskId = task.id;
  assert.equal(TodoTask.find(taskId).title, 'Model task');
  assert.ok(TodoTask.update(taskId, { completed: true }));
  assert.equal(TodoTask.find(taskId).completed, true);
  assert.ok(TodoTask.update(taskId, { title: 'Updated model task', dueAt: '2026-10-26T10:00' }));
  assert.equal(TodoTask.find(taskId).title, 'Updated model task');
  assert.equal(TodoTask.delete(taskId), true);

  assert.equal(Workflow.setWorkflowEnabled(workflowId, false), true);
  const runId = Workflow.startWorkflowRun(workflowId);
  Workflow.finishWorkflowRun(workflowId, runId, { records: 1 }, null);
  const oldRunQuery = `SELECT r.id, r.workflow_id, w.name AS workflow_name, r.status, r.started_at, r.finished_at, r.result_json, r.error_text
    FROM workflow_runs r JOIN workflows w ON w.id = r.workflow_id ORDER BY r.started_at DESC LIMIT ?`;
  assert.deepEqual(ApplicationRecord.query(oldRunQuery, 30).map((row) => ({ ...row, result: row.result_json ? JSON.parse(row.result_json) : null })), db.prepare(oldRunQuery).all(30).map((row) => ({ ...row, result: row.result_json ? JSON.parse(row.result_json) : null })));
  const oldDueWorkflowQuery = `SELECT id, plugin_id, integration_id, name, trigger_type, definition_json, enabled, next_run_at
    FROM workflows WHERE enabled = 1 AND trigger_type = 'schedule' AND next_run_at IS NOT NULL AND julianday(next_run_at) <= julianday('now')`;
  assert.deepEqual(ApplicationRecord.query(oldDueWorkflowQuery).map((row) => ({ ...row, definition: JSON.parse(row.definition_json) })), db.prepare(oldDueWorkflowQuery).all().map((row) => ({ ...row, definition: JSON.parse(row.definition_json) })));

  assert.ok(Integration.update(integrationId, { display_name: 'Calendar account', account_label: 'Personal Gmail' }));
  assert.equal(Integration.setIntegrationStatus(integrationId, 'paused'), true);
  assert.equal(Integration.removeIntegration(integrationId), true);
});
