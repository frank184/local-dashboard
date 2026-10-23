const { app, BrowserWindow, ipcMain, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { openDatabase } = require('./db/database');
const ApplicationRecord = require('./models/application-record');
const { Plugin } = require('./models/plugin');
const { Integration } = require('./models/integration');
const { IntegrationCalendar } = require('./models/integration-calendar');
const { Workflow } = require('./models/workflow');
const { CalendarEvent } = require('./models/calendar-event');
const { TodoTask } = require('./models/todo-task');
const { HealthMetric } = require('./models/health-metric');
const { connectFitbit, syncFitbit } = require('./integrations/fitbit');
const { connectGoogleCalendar, listGoogleCalendars, syncGoogleCalendar } = require('./integrations/google-calendar');
const { connectOutlookCalendar, listOutlookCalendars, syncOutlookCalendar } = require('./integrations/outlook-calendar');

const activeWorkflowRuns = new Set();

function loadGoogleClientIdFromLocalEnv() {
  if (process.env.GOOGLE_CALENDAR_CLIENT_ID?.trim()) return;
  try {
    const envFile = fs.readFileSync(path.join(__dirname, '../.env'), 'utf8');
    const line = envFile.split(/\r?\n/).find((entry) => /^\s*(?:export\s+)?GOOGLE_CALENDAR_CLIENT_ID\s*=/.test(entry));
    if (!line) return;
    let value = line.replace(/^\s*(?:export\s+)?GOOGLE_CALENDAR_CLIENT_ID\s*=\s*/, '').trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '').trim();
    if (value) process.env.GOOGLE_CALENDAR_CLIENT_ID = value;
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('Could not read local .env file:', error.message);
  }
}

loadGoogleClientIdFromLocalEnv();

function registerIpcHandlers() {
  ipcMain.handle('dashboard:get-page-data', (_event, pageId) => {
    switch (pageId) {
      case 'plugins': return { plugins: Plugin.where({ kind: { $ne: 'source' } }, { select: ['id', 'name', 'version', 'domain_id', 'kind', 'enabled', 'installed', 'description', 'icon'], orderBy: 'name' }) };
      case 'navigation': return { plugins: Plugin.where({ installed: 1, enabled: 1 }, { select: ['id', 'name', 'icon'], orderBy: ['installed_at', 'name'] }) };
      case 'integrations': return { integrations: integrationSummaries() };
      case 'workflows': return { workflows: workflowSummaries(), runs: workflowRuns() };
      case 'calendar': return {
        events: CalendarEvent.all().map((event) => event.toJSON()),
        integrations: integrationSummaries(),
        settings: getPluginSetting('calendar', 'visible-hours') || { startHour: 0, endHour: 24 },
        sidePanelCollapsed: getPluginSetting('calendar', 'side-panel-collapsed') === true,
      };
      case 'todos': return { tasks: TodoTask.all().map((task) => task.toJSON()) };
      case 'health': {
        const metrics = HealthMetric.all().map((metric) => metric.toJSON());
        return { sleep: metrics.filter((metric) => metric.record_type === 'health_sleep'), weight: metrics.filter((metric) => metric.record_type === 'health_weight') };
      }
      default: return {};
    }
  });
  ipcMain.handle('dashboard:set-task-completed', (_event, id, completed) => Boolean(TodoTask.update(id, { completed: Boolean(completed) })));
  ipcMain.handle('dashboard:create-task', (_event, task) => TodoTask.create(task).id);
  ipcMain.handle('dashboard:update-task', (_event, task) => Boolean(TodoTask.update(task.id, task)));
  ipcMain.handle('dashboard:delete-task', (_event, id) => TodoTask.delete(id));
  ipcMain.handle('dashboard:save-plugin', (_event, plugin) => {
    const existing = Plugin.find(plugin.id);
    if (!existing || !existing.installed) return false;
    return Boolean(Plugin.update(plugin.id, {
      name: plugin.name.trim(), description: plugin.description || '', domain_id: plugin.domainId,
      kind: plugin.kind || 'feature', icon: plugin.icon || 'blocks', enabled: Number(plugin.enabled),
    }));
  });
  ipcMain.handle('dashboard:get-plugin-setting', (_event, pluginId, key) => getPluginSetting(pluginId, key));
  ipcMain.handle('dashboard:set-plugin-setting', (_event, pluginId, key, value) => setPluginSetting(pluginId, key, value));
  ipcMain.handle('dashboard:create-plugin', (_event, plugin) => Plugin.create({ name: plugin.name.trim(), domain_id: plugin.domainId, kind: plugin.kind, description: plugin.description, icon: plugin.icon }).id);
  ipcMain.handle('dashboard:uninstall-plugin', (_event, id) => Plugin.uninstallPlugin(id));
  ipcMain.handle('dashboard:install-plugin', (_event, id) => Plugin.installPlugin(id));
  ipcMain.handle('dashboard:add-integration', (_event, integration) => Integration.create({ provider_id: integration.providerId, display_name: integration.displayName, account_label: integration.accountLabel, plugin_id: integration.pluginId }).id);
  ipcMain.handle('dashboard:remove-integration', (_event, id) => Integration.removeIntegration(id));
  ipcMain.handle('dashboard:update-integration', (_event, id, values) => Boolean(Integration.update(id, { display_name: values.displayName.trim(), account_label: (values.accountLabel || '').trim() })));
  ipcMain.handle('dashboard:set-integration-status', (_event, id, status) => Integration.setIntegrationStatus(id, status));
  ipcMain.handle('dashboard:set-workflow-enabled', (_event, id, enabled) => Workflow.setWorkflowEnabled(id, enabled));
  ipcMain.handle('dashboard:run-workflow', (_event, id) => executeWorkflow(id));
  ipcMain.handle('dashboard:connect-google-calendar', async (_event, { accountLabel, integrationId }) => {
    const clientId = process.env.GOOGLE_CALENDAR_CLIENT_ID;
    if (!clientId?.trim()) throw new Error('Set GOOGLE_CALENDAR_CLIENT_ID in your environment or local .env file before connecting Google Calendar.');
    if (!await safeStorage.isAsyncEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === 'basic_text') throw new Error('OS credential storage is unavailable. Set up your desktop keyring before connecting Google Calendar.');
    const existing = integrationId ? Integration.find(integrationId) : null;
    if (integrationId && (!existing || existing.provider_id !== 'google-calendar')) throw new Error('Google Calendar connection not found.');
    const connected = await connectGoogleCalendar({ clientId });
    if (!connected.token.refresh_token && existing?.secret_blob && JSON.parse(existing.config_json || '{}').clientId === clientId.trim()) {
      const previousToken = JSON.parse((await safeStorage.decryptStringAsync(Buffer.from(existing.secret_blob, 'base64'))).result);
      connected.token.refresh_token = previousToken.refresh_token;
    }
    if (!connected.token.refresh_token) throw new Error('Google did not return an offline refresh token. Remove any old Local Dashboard grant from your Google Account and connect again.');
    const id = integrationId || Integration.create({ provider_id: 'google-calendar', display_name: 'Google Calendar', account_label: accountLabel || connected.email, plugin_id: 'google-calendar-connector' }).id;
    try {
      const encrypted = (await safeStorage.encryptStringAsync(JSON.stringify(connected.token))).toString('base64');
      Integration.update(id, { config_json: JSON.stringify({ clientId: clientId.trim(), email: connected.email }), secret_blob: encrypted, account_label: accountLabel || connected.email || 'Google account', status: 'connected' });
      const calendars = await listGoogleCalendars(connected.token);
      saveProviderCalendars(id, calendars.map((calendar) => ({ id: calendar.id, summary: calendar.summary || calendar.id, timeZone: calendar.timeZone, backgroundColor: calendar.backgroundColor })));
      const workflowId = Integration.ensureCalendarSyncWorkflow(id);
      const result = await executeGoogleCalendarWorkflow(workflowId);
      return { id, workflowId, email: connected.email, calendarCount: calendars.length, ...result };
    } catch (error) {
      Integration.update(id, { status: 'error' });
      throw new Error(`Google account connected, but initial calendar sync failed: ${error.message}`);
    }
  });
  ipcMain.handle('dashboard:sync-google-calendar', async (_event, id) => {
    const workflowId = Integration.find(id)?.sync_workflow_id;
    if (!workflowId) throw new Error('No sync workflow is attached to this Google Calendar connection.');
    return executeGoogleCalendarWorkflow(workflowId);
  });
  ipcMain.handle('dashboard:connect-outlook-calendar', async (_event, { clientId, accountLabel, integrationId }) => {
    if (!clientId?.trim()) throw new Error('Enter the Microsoft application (client) ID first.');
    if (!await safeStorage.isAsyncEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === 'basic_text') throw new Error('OS credential storage is unavailable. Set up your desktop keyring before connecting Outlook.');
    const existing = integrationId ? Integration.find(integrationId) : null;
    if (integrationId && (!existing || existing.provider_id !== 'outlook-calendar')) throw new Error('Outlook Calendar connection not found.');
    const connected = await connectOutlookCalendar({ clientId });
    if (!connected.token.refresh_token && existing?.secret_blob && JSON.parse(existing.config_json || '{}').clientId === clientId.trim()) {
      const previousToken = JSON.parse((await safeStorage.decryptStringAsync(Buffer.from(existing.secret_blob, 'base64'))).result);
      connected.token.refresh_token = previousToken.refresh_token;
    }
    if (!connected.token.refresh_token) throw new Error('Microsoft did not return a refresh token. Remove any old Local Dashboard consent and connect again.');
    const id = integrationId || Integration.create({ provider_id: 'outlook-calendar', display_name: 'Outlook Calendar', account_label: accountLabel || connected.email, plugin_id: 'outlook-calendar-connector' }).id;
    try {
      const encrypted = (await safeStorage.encryptStringAsync(JSON.stringify(connected.token))).toString('base64');
      Integration.update(id, { config_json: JSON.stringify({ clientId: clientId.trim(), email: connected.email }), secret_blob: encrypted, account_label: accountLabel || connected.email || 'Microsoft account', status: 'connected' });
      const calendars = await listOutlookCalendars(connected.token);
      saveProviderCalendars(id, calendars.map((calendar) => ({ id: calendar.id, summary: calendar.name || calendar.id, timeZone: null, backgroundColor: calendar.hexColor || null })));
      const workflowId = Integration.ensureCalendarSyncWorkflow(id);
      const result = await executeOutlookCalendarWorkflow(workflowId);
      return { id, workflowId, email: connected.email, calendarCount: calendars.length, ...result };
    } catch (error) {
      updateIntegrationSyncResult(id, 'error');
      throw new Error(`Outlook account connected, but initial calendar sync failed: ${error.message}`);
    }
  });
  ipcMain.handle('dashboard:sync-outlook-calendar', async (_event, id) => {
    const workflowId = Integration.find(id)?.sync_workflow_id;
    if (!workflowId) throw new Error('No sync workflow is attached to this Outlook connection.');
    return executeOutlookCalendarWorkflow(workflowId);
  });
  ipcMain.handle('dashboard:get-integration-calendars', (_event, id) => IntegrationCalendar.where({ integration_id: id }, {
    select: ['id', 'integration_id', 'external_calendar_id', 'summary', 'timezone', 'color', 'selected', 'last_sync_at', 'sync_window_start', 'sync_window_end'], orderBy: 'summary',
  }).map((calendar) => calendar.toJSON()));
  ipcMain.handle('dashboard:set-integration-calendars', (_event, id, selections) => IntegrationCalendar.setIntegrationCalendarSelection(id, selections));
  ipcMain.handle('dashboard:connect-fitbit', async (_event, { clientId, accountLabel, integrationId }) => {
    const existing = integrationId ? Integration.find(integrationId) : null;
    if (integrationId && (!existing || existing.provider_id !== 'fitbit')) throw new Error('Fitbit integration not found.');
    const id = integrationId || Integration.create({ provider_id: 'fitbit', display_name: 'Fitbit Web API (legacy)', account_label: accountLabel, plugin_id: 'fitbit-connector' }).id;
    try {
      const token = await connectFitbit({ clientId });
      if (!await safeStorage.isAsyncEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === 'basic_text') throw new Error('OS credential storage is unavailable. Set up your desktop keyring before connecting Fitbit.');
      token.expires_at = Date.now() + Number(token.expires_in || 28800) * 1000;
      const encrypted = (await safeStorage.encryptStringAsync(JSON.stringify(token))).toString('base64');
      Integration.update(id, { config_json: JSON.stringify({ clientId }), secret_blob: encrypted, account_label: accountLabel || '', status: 'connected' });
      const workflowId = Integration.ensureFitbitWorkflow(id);
      return { id, workflowId };
    } catch (error) { if (!integrationId) Integration.removeIntegration(id); throw new Error(error.message); }
  });
  ipcMain.handle('dashboard:sync-fitbit', async (_event, id) => {
    const workflowId = Integration.find(id)?.sync_workflow_id;
    if (!workflowId) throw new Error('No sync workflow is attached to this Fitbit integration.');
    return executeFitbitWorkflow(workflowId);
  });
  ipcMain.handle('dashboard:create-calendar-event', (_event, event) => CalendarEvent.create(event).id);
  ipcMain.handle('dashboard:update-calendar-event', (_event, event) => Boolean(CalendarEvent.update(event.id, event)));
  ipcMain.handle('dashboard:delete-calendar-event', (_event, id) => CalendarEvent.delete(id));
}

function integrationSummaries() {
  return ApplicationRecord.query(`SELECT id, provider_id, display_name, account_label, status, plugin_id, sync_workflow_id, last_sync_at, config_json,
    secret_blob IS NOT NULL AS has_credentials,
    (SELECT COUNT(*) FROM integration_calendars c WHERE c.integration_id = integrations.id AND c.selected = 1) AS selected_calendar_count
    FROM integrations ORDER BY display_name, account_label`);
}

function getPluginSetting(pluginId, stateKey) {
  const row = ApplicationRecord.query('SELECT value_json FROM plugin_state WHERE plugin_id = ? AND state_key = ?', pluginId, stateKey)[0];
  if (!row) return null;
  try { return JSON.parse(row.value_json); } catch { return null; }
}

function updateIntegrationSyncResult(id, status) {
  const attributes = { status };
  if (status === 'connected') attributes.last_sync_at = new Date().toISOString();
  return Boolean(Integration.update(id, attributes));
}

function setPluginSetting(pluginId, stateKey, value) {
  if (!stateKey?.trim()) throw new Error('Plugin setting key is required.');
  const valueJson = JSON.stringify(value);
  if (valueJson === undefined) throw new Error('Plugin setting must be JSON serializable.');
  ApplicationRecord.execute(`INSERT INTO plugin_state (plugin_id, state_key, value_json, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(plugin_id, state_key) DO UPDATE SET value_json = excluded.value_json, updated_at = datetime('now')`, pluginId, stateKey.trim(), valueJson);
  return value;
}

function selectedCalendars(integrationId) {
  return ApplicationRecord.query(`SELECT c.id, c.integration_id, c.external_calendar_id, c.summary, c.timezone, c.color, c.sync_token, c.sync_window_start, c.sync_window_end, i.account_label
    FROM integration_calendars c JOIN integrations i ON i.id = c.integration_id
    WHERE c.integration_id = ? AND c.selected = 1 ORDER BY c.summary`, integrationId);
}

function workflowSummaries() {
  return ApplicationRecord.query(`SELECT w.id, w.plugin_id, w.integration_id, w.name, w.trigger_type, w.definition_json, w.enabled, w.next_run_at, w.last_run_at,
      i.display_name AS integration_name, i.status AS integration_status
    FROM workflows w LEFT JOIN integrations i ON i.id = w.integration_id ORDER BY w.created_at DESC`)
    .map((row) => ({ ...row, definition: JSON.parse(row.definition_json) }));
}

function dueWorkflows() {
  return ApplicationRecord.query(`SELECT id, plugin_id, integration_id, name, trigger_type, definition_json, enabled, next_run_at
    FROM workflows WHERE enabled = 1 AND trigger_type = 'schedule' AND next_run_at IS NOT NULL AND julianday(next_run_at) <= julianday('now')`)
    .map((row) => ({ ...row, definition: JSON.parse(row.definition_json) }));
}

function workflowRuns(limit = 30) {
  return ApplicationRecord.query(`SELECT r.id, r.workflow_id, w.name AS workflow_name, r.status, r.started_at, r.finished_at, r.result_json, r.error_text
    FROM workflow_runs r JOIN workflows w ON w.id = r.workflow_id ORDER BY r.started_at DESC LIMIT ?`, limit)
    .map((row) => ({ ...row, result: row.result_json ? JSON.parse(row.result_json) : null }));
}

function saveProviderCalendars(integrationId, calendars) {
  IntegrationCalendar.upsertAll(calendars.map((calendar) => ({
    integration_id: integrationId,
    external_calendar_id: calendar.id,
    summary: calendar.summary || calendar.id,
    timezone: calendar.timeZone || null,
    color: calendar.backgroundColor || null,
  })), {
    uniqueBy: ['integration_id', 'external_calendar_id'],
    updateColumns: ['summary', 'timezone', 'color'],
  });
  return IntegrationCalendar.where({ integration_id: integrationId }, {
    select: ['id', 'integration_id', 'external_calendar_id', 'summary', 'timezone', 'color', 'selected', 'last_sync_at', 'sync_window_start', 'sync_window_end'],
    orderBy: 'summary',
  }).map((calendar) => calendar.toJSON());
}

function saveCalendarCursor(calendarId, syncToken, windowStart = null, windowEnd = null) {
  return Boolean(IntegrationCalendar.update(calendarId, {
    sync_token: syncToken,
    sync_window_start: windowStart,
    sync_window_end: windowEnd,
    last_sync_at: new Date().toISOString(),
  }));
}

function upsertCalendarEvents(integrationId, sourcePluginId, events) {
  CalendarEvent.upsertAll(events.map((event) => ({
    id: event.id,
    domain_id: 'personal-productivity',
    record_type: 'calendar_events',
    contract_version: 2,
    source_plugin_id: sourcePluginId,
    integration_id: integrationId,
    external_id: event.externalId,
    occurred_at: event.occurredAt,
    payload_json: JSON.stringify(event.payload),
  })), {
    uniqueBy: ['source_plugin_id', 'external_id'],
    updateColumns: ['contract_version', 'integration_id', 'occurred_at', 'payload_json'],
  });
  return events.length;
}

function deleteCalendarEvents(integrationId, sourcePluginId, calendarExternalId, externalIds) {
  if (externalIds?.length) return CalendarEvent.deleteWhere({ integration_id: integrationId, source_plugin_id: sourcePluginId, external_id: { $in: externalIds } });
  if (externalIds) return 0;
  return CalendarEvent.deleteWhere({ integration_id: integrationId, source_plugin_id: sourcePluginId, external_id: { $like: `calendar:${integrationId}:${calendarExternalId}:%` } });
}

function upsertHealthRecords(integrationId, items) {
  HealthMetric.upsertAll(items.map((item) => ({
    id: item.id,
    domain_id: 'personal-health',
    record_type: item.recordType,
    source_plugin_id: 'fitbit-connector',
    integration_id: integrationId,
    external_id: item.externalId,
    occurred_at: item.occurredAt,
    payload_json: JSON.stringify(item.payload),
  })), {
    uniqueBy: ['source_plugin_id', 'external_id'],
    updateColumns: ['integration_id', 'occurred_at', 'payload_json'],
  });
  return items.length;
}


async function executeFitbitWorkflow(workflowId) {
  const workflow = Workflow.find(workflowId);
  if (!workflow) throw new Error('Workflow not found.');
  if (activeWorkflowRuns.has(workflowId)) throw new Error('This workflow is already running.');
  if (workflow.definition.jobType !== 'data_sync' || workflow.definition.providerId !== 'fitbit') throw new Error('No runner is registered for this workflow type.');
  activeWorkflowRuns.add(workflowId);
  const runId = Workflow.startWorkflowRun(workflowId);
  try {
    const integration = Integration.find(workflow.integration_id);
    if (!integration || integration.provider_id !== 'fitbit' || !integration.secret_blob) throw new Error('Reconnect Fitbit before running this workflow.');
    const decrypted = await safeStorage.decryptStringAsync(Buffer.from(integration.secret_blob, 'base64'));
    const { token, items } = await syncFitbit({ clientId: JSON.parse(integration.config_json).clientId, token: JSON.parse(decrypted.result), integrationId: integration.id });
    token.expires_at = Date.now() + Number(token.expires_in || 28800) * 1000;
    const encrypted = (await safeStorage.encryptStringAsync(JSON.stringify(token))).toString('base64');
    Integration.update(integration.id, { secret_blob: encrypted });
    const count = upsertHealthRecords(integration.id, items);
    updateIntegrationSyncResult(integration.id, 'connected');
    const result = { recordCount: count, sourceTypes: ['health_sleep', 'health_weight'] };
    Workflow.finishWorkflowRun(workflowId, runId, result, null);
    return result;
  } catch (error) {
    if (workflow.integration_id) updateIntegrationSyncResult(workflow.integration_id, 'error');
    Workflow.finishWorkflowRun(workflowId, runId, null, error.message);
    throw new Error(error.message);
  } finally { activeWorkflowRuns.delete(workflowId); }
}

async function executeWorkflow(workflowId) {
  const workflow = Workflow.find(workflowId);
    if (workflow?.definition.providerId === 'google-calendar') return executeGoogleCalendarWorkflow(workflowId);
    if (workflow?.definition.providerId === 'outlook-calendar') return executeOutlookCalendarWorkflow(workflowId);
  if (workflow?.definition.providerId === 'fitbit') return executeFitbitWorkflow(workflowId);
  throw new Error('No runner is registered for this workflow type.');
}

async function executeGoogleCalendarWorkflow(workflowId) {
  const workflow = Workflow.find(workflowId);
  if (!workflow) throw new Error('Workflow not found.');
  if (activeWorkflowRuns.has(workflowId)) throw new Error('This workflow is already running.');
  if (workflow.definition.jobType !== 'data_sync' || workflow.definition.providerId !== 'google-calendar') throw new Error('No runner is registered for this workflow type.');
  activeWorkflowRuns.add(workflowId);
  const runId = Workflow.startWorkflowRun(workflowId);
  try {
    const integration = Integration.find(workflow.integration_id);
    if (!integration || integration.provider_id !== 'google-calendar' || !integration.secret_blob) throw new Error('Reconnect this Google account before running its workflow.');
    const credentials = JSON.parse(integration.config_json);
    const token = JSON.parse((await safeStorage.decryptStringAsync(Buffer.from(integration.secret_blob, 'base64'))).result);
    const calendars = selectedCalendars(integration.id);
    const result = await syncGoogleCalendar({
      clientId: credentials.clientId, token, integrationId: integration.id, calendars,
      getSyncToken: (calendarId) => calendars.find((calendar) => calendar.id === calendarId)?.sync_token,
      saveSyncToken: saveCalendarCursor,
      importEvents: (id, events) => upsertCalendarEvents(id, 'google-calendar-connector', events),
      deleteEvents: (id, calendarId, externalIds) => deleteCalendarEvents(id, 'google-calendar-connector', calendarId, externalIds),
    });
    result.token.expires_at = Date.now() + Number(result.token.expires_in || 3600) * 1000;
    const encrypted = (await safeStorage.encryptStringAsync(JSON.stringify(result.token))).toString('base64');
    Integration.update(integration.id, { secret_blob: encrypted });
    updateIntegrationSyncResult(integration.id, 'connected');
    const summary = { recordCount: result.recordCount, calendarCount: result.calendarCount, sourceTypes: ['calendar_events'] };
    Workflow.finishWorkflowRun(workflowId, runId, summary, null);
    return summary;
  } catch (error) {
    if (workflow.integration_id) updateIntegrationSyncResult(workflow.integration_id, 'error');
    Workflow.finishWorkflowRun(workflowId, runId, null, error.message);
    throw new Error(error.message);
  } finally { activeWorkflowRuns.delete(workflowId); }
}

async function executeOutlookCalendarWorkflow(workflowId) {
  const workflow = Workflow.find(workflowId);
  if (!workflow) throw new Error('Workflow not found.');
  if (activeWorkflowRuns.has(workflowId)) throw new Error('This workflow is already running.');
  if (workflow.definition.jobType !== 'data_sync' || workflow.definition.providerId !== 'outlook-calendar') throw new Error('No runner is registered for this workflow type.');
  activeWorkflowRuns.add(workflowId);
  const runId = Workflow.startWorkflowRun(workflowId);
  try {
    const integration = Integration.find(workflow.integration_id);
    if (!integration || integration.provider_id !== 'outlook-calendar' || !integration.secret_blob) throw new Error('Reconnect this Microsoft account before running its workflow.');
    const credentials = JSON.parse(integration.config_json);
    const token = JSON.parse((await safeStorage.decryptStringAsync(Buffer.from(integration.secret_blob, 'base64'))).result);
    const calendars = selectedCalendars(integration.id);
    const result = await syncOutlookCalendar({
      clientId: credentials.clientId, token, integrationId: integration.id, calendars,
      getSyncToken: (calendarId) => calendars.find((calendar) => calendar.id === calendarId)?.sync_token,
      saveSyncToken: saveCalendarCursor,
      importEvents: (id, events) => upsertCalendarEvents(id, 'outlook-calendar-connector', events),
      deleteEvents: (id, calendarId, externalIds) => deleteCalendarEvents(id, 'outlook-calendar-connector', calendarId, externalIds),
    });
    result.token.expires_at = Date.now() + Number(result.token.expires_in || 3600) * 1000;
    const encrypted = (await safeStorage.encryptStringAsync(JSON.stringify(result.token))).toString('base64');
    Integration.update(integration.id, { secret_blob: encrypted });
    updateIntegrationSyncResult(integration.id, 'connected');
    const summary = { recordCount: result.recordCount, calendarCount: result.calendarCount, sourceTypes: ['calendar_events'] };
    Workflow.finishWorkflowRun(workflowId, runId, summary, null);
    return summary;
  } catch (error) {
    if (workflow.integration_id) updateIntegrationSyncResult(workflow.integration_id, 'error');
    Workflow.finishWorkflowRun(workflowId, runId, null, error.message);
    throw new Error(error.message);
  } finally { activeWorkflowRuns.delete(workflowId); }
}

function startWorkflowScheduler() {
  const timer = setInterval(() => {
    for (const workflow of dueWorkflows()) {
      if (workflow.definition.jobType === 'data_sync' && workflow.definition.providerId === 'fitbit' && !activeWorkflowRuns.has(workflow.id)) void executeFitbitWorkflow(workflow.id).catch((error) => console.error('Scheduled workflow failed', error));
      if (workflow.definition.jobType === 'data_sync' && workflow.definition.providerId === 'google-calendar' && !activeWorkflowRuns.has(workflow.id)) void executeGoogleCalendarWorkflow(workflow.id).catch((error) => console.error('Scheduled workflow failed', error));
      if (workflow.definition.jobType === 'data_sync' && workflow.definition.providerId === 'outlook-calendar' && !activeWorkflowRuns.has(workflow.id)) void executeOutlookCalendarWorkflow(workflow.id).catch((error) => console.error('Scheduled workflow failed', error));
    }
  }, 60_000);
  timer.unref();
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'Local Dashboard',
    backgroundColor: '#f5f6f8',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.loadFile(path.join(__dirname, '../dist/index.html'));
}

app.whenReady().then(() => {
  ApplicationRecord.connect(openDatabase(app.getPath('userData')));
  registerIpcHandlers();
  startWorkflowScheduler();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => ApplicationRecord.disconnect());

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
