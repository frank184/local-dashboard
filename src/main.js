const { app, BrowserWindow, dialog, ipcMain, safeStorage } = require('electron');
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
const { FinanceTransaction } = require('./models/finance-transaction');
const { randomUUID } = require('node:crypto');
const { MAX_FILE_BYTES, parseStatementBuffer, buildPreview, slicePreview, isSupportedCurrency, transactionFingerprint } = require('./services/finance/statement-csv');
const { connectFitbit, syncFitbit } = require('./integrations/fitbit');
const { connectGoogleCalendar, listGoogleCalendars, syncGoogleCalendar } = require('./integrations/google-calendar');
const { connectOutlookCalendar, listOutlookCalendars, syncOutlookCalendar } = require('./integrations/outlook-calendar');

const activeWorkflowRuns = new Set();
const financeImportSessions = new Map();
const financeStatementWorkflowId = 'workflow-finance-statement-import';

function loadOAuthSettingsFromLocalEnv() {
  try {
    const envFile = fs.readFileSync(path.join(__dirname, '../.env'), 'utf8');
    for (const key of ['GOOGLE_CALENDAR_CLIENT_ID', 'OUTLOOK_CALENDAR_CLIENT_ID']) {
      if (process.env[key]?.trim()) continue;
      const line = envFile.split(/\r?\n/).find((entry) => new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`).test(entry));
      if (!line) continue;
      let value = line.replace(new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*`), '').trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      else value = value.replace(/\s+#.*$/, '').trim();
      if (value) process.env[key] = value;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('Could not read local .env file:', error.message);
  }
}

loadOAuthSettingsFromLocalEnv();

// Electron does not currently recognize Hyprland/Omarchy as a Linux desktop
// keyring environment. These sessions commonly expose GNOME Keyring through
// Secret Service, so select libsecret explicitly instead of falling back to
// Electron's basic_text backend.
if (process.platform === 'linux' && /(?:^|[:;])(hyprland|omarchy)(?:$|[:;])/i.test(`${process.env.XDG_CURRENT_DESKTOP || ''}:${process.env.DESKTOP_SESSION || ''}:${process.env.XDG_SESSION_DESKTOP || ''}`)) {
  app.commandLine.appendSwitch('password-store', 'gnome-libsecret');
}

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
        return { sleep: metrics.filter((metric) => metric.record_type === 'health_sleep'), weight: metrics.filter((metric) => metric.record_type === 'health_weight'), settings: getPluginSetting('health', 'dashboard') || { weightUnit: 'lb', dateRange: '18m' } };
      }
      case 'finance': return { transactions: FinanceTransaction.all().map((record) => record.toJSON()), lastImportRun: latestFinanceImportRun(), importWorkflowEnabled: Boolean(Workflow.find(financeStatementWorkflowId)?.enabled) };
      default: return {};
    }
  });
  ipcMain.handle('dashboard:set-task-completed', (_event, id, completed) => Boolean(TodoTask.update(id, { completed: Boolean(completed) })));
  ipcMain.handle('dashboard:create-task', (_event, task) => TodoTask.create(task).id);
  ipcMain.handle('dashboard:create-finance-transaction', (_event, transaction) => FinanceTransaction.createLocal(transaction));
  ipcMain.handle('dashboard:clear-finance-samples', () => FinanceTransaction.clearSamples());
  ipcMain.handle('dashboard:choose-finance-statement', async () => {
    const workflow = Workflow.find(financeStatementWorkflowId);
    if (!workflow || !workflow.enabled) throw new Error('The Finance statement import workflow is paused. Resume it from Workflows before importing.');
    const selection = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow(), {
      title: 'Choose a bank statement', properties: ['openFile'],
      filters: [{ name: 'CSV statement', extensions: ['csv', 'tsv'] }],
    });
    if (selection.canceled || !selection.filePaths[0]) return { cancelled: true };
    for (const [id, session] of financeImportSessions) cancelFinanceImportSession(id, session);
    const filePath = selection.filePaths[0];
    const filename = path.basename(filePath);
    const workflowRunId = Workflow.startWorkflowRun(financeStatementWorkflowId);
    try {
      Workflow.updateWorkflowRunProgress(workflowRunId, { stage: 'read_file', filename });
      const stat = await fs.promises.stat(filePath);
      if (stat.size > MAX_FILE_BYTES) throw new Error('This CSV is larger than the 10 MB import limit.');
      const buffer = await fs.promises.readFile(filePath);
      const statement = parseStatementBuffer(buffer, filename);
      const importId = randomUUID();
      financeImportSessions.set(importId, { statement, buffer, filename, workflowRunId, preview: null, mapping: null, existingFingerprints: null, createdAt: Date.now(), reviewedPages: new Set(), rowOverrides: {}, keepPossibleDuplicates: false, currentPreviewOffset: 0 });
      Workflow.updateWorkflowRunProgress(workflowRunId, { stage: 'map_columns', filename, rowCount: statement.rows.length });
      return { importId, filename, headers: statement.headers, delimiter: statement.delimiter, suggestions: statement.suggestions, rowCount: statement.rows.length,
        sampleRows: statement.rows.slice(0, 5).map(({ rowNumber, cells }) => ({ rowNumber, cells: cells.slice(0, 12).map((cell) => cell.slice(0, 240)) })), delimiterOptions: statement.delimiterOptions };
    } catch (error) {
      Workflow.finishWorkflowRun(financeStatementWorkflowId, workflowRunId, { stage: 'failed', filename }, error.message);
      throw error;
    }
  });
  ipcMain.handle('dashboard:select-finance-statement-delimiter', (_event, request) => {
    const session = getFinanceImportSession(request?.importId);
    const statement = parseStatementBuffer(session.buffer, session.filename, request.delimiter);
    session.statement = statement; session.preview = null; session.previewKey = null; session.mapping = null;
    session.reviewedPages.clear(); session.rowOverrides = {}; session.keepPossibleDuplicates = false;
    session.currentPreviewOffset = 0;
    return { headers: statement.headers, delimiter: statement.delimiter, suggestions: statement.suggestions, rowCount: statement.rows.length,
      sampleRows: statement.rows.slice(0, 5).map(({ rowNumber, cells }) => ({ rowNumber, cells: cells.slice(0, 12).map((cell) => cell.slice(0, 240)) })), delimiterOptions: statement.delimiterOptions };
  });
  ipcMain.handle('dashboard:preview-finance-statement', (_event, request) => {
    const session = getFinanceImportSession(request?.importId);
    const existingFingerprints = session.existingFingerprints || FinanceTransaction.all().filter((record) => record.sourceName !== 'Local sample').map((record) => transactionFingerprint({ date: String(record.occurred_at).slice(0, 10), description: record.merchant || '', amount: record.amount, currency: record.currency || 'CAD', direction: record.direction || '', accountLabel: record.accountLabel || '' }));
    const mapping = request.mapping || session.mapping;
    const fallbackCurrency = request.fallbackCurrency || session.fallbackCurrency || 'CAD';
    const accountLabel = request.accountLabel ?? session.accountLabel ?? '';
    const previewKey = JSON.stringify({ mapping, fallbackCurrency, accountLabel, delimiter: session.statement.delimiter });
    if (!session.preview || session.previewKey !== previewKey) {
      session.reviewedPages.clear(); session.rowOverrides = {}; session.keepPossibleDuplicates = false;
      Workflow.updateWorkflowRunProgress(session.workflowRunId, { stage: 'normalize', filename: session.filename, rowCount: session.statement.rows.length });
      session.preview = buildPreview(session.statement, mapping, { fallbackCurrency, accountLabel, existingFingerprints });
      session.previewKey = previewKey;
    }
    const preview = slicePreview(session.preview, request.offset || 0);
    session.currentPreviewOffset = preview.previewOffset;
    session.mapping = mapping; session.fallbackCurrency = fallbackCurrency; session.accountLabel = accountLabel; session.existingFingerprints = existingFingerprints;
    Workflow.updateWorkflowRunProgress(session.workflowRunId, { stage: 'deduplicate', filename: session.filename, validCount: preview.validCount, duplicateCount: preview.duplicateCount });
    Workflow.updateWorkflowRunProgress(session.workflowRunId, { stage: 'preview_rows', filename: session.filename, validCount: preview.validCount, invalidCount: preview.invalidCount, duplicateCount: preview.duplicateCount });
    const { _normalizedRows, _allRows, ...publicPreview } = preview;
    return publicPreview;
  });
  ipcMain.handle('dashboard:review-finance-statement-page', (_event, request) => {
    const session = getFinanceImportSession(request?.importId);
    if (!session.preview || request.offset !== session.currentPreviewOffset) throw new Error('Review the currently displayed page before continuing.');
    const rows = slicePreview(session.preview, request.offset).previewRows;
    if (typeof request.keepPossibleDuplicates === 'boolean' && request.keepPossibleDuplicates !== session.keepPossibleDuplicates) session.reviewedPages.clear();
    if (typeof request.keepPossibleDuplicates === 'boolean') session.keepPossibleDuplicates = request.keepPossibleDuplicates;
    if (request.acknowledged !== true) { session.reviewedPages.delete(request.offset); return { reviewedPages: session.reviewedPages.size }; }
    for (const [rowNumber, included] of Object.entries(request.rowOverrides || {})) {
      const row = rows.find((candidate) => candidate.rowNumber === Number(rowNumber));
      if (!row?.valid || typeof included !== 'boolean') throw new Error('A row selection does not belong to the current review page.');
      session.rowOverrides[row.rowNumber] = included;
    }
    session.reviewedPages.add(request.offset);
    return { reviewedPages: session.reviewedPages.size, keepPossibleDuplicates: session.keepPossibleDuplicates };
  });
  ipcMain.handle('dashboard:import-finance-statement', (_event, request) => commitFinanceImport(request?.importId));
  ipcMain.handle('dashboard:cancel-finance-statement', (_event, importId) => {
    const session = financeImportSessions.get(importId);
    if (!session) return false;
    cancelFinanceImportSession(importId, session);
    return true;
  });
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
  ipcMain.handle('dashboard:update-integration', (_event, id, values) => {
    const integration = Integration.find(id);
    if (!integration) return false;
    const config = JSON.parse(integration.config_json || '{}');
    const updated = Boolean(Integration.update(id, { display_name: values.displayName.trim(), account_label: (values.accountLabel || '').trim() || config.email || '' }));
    if (updated && ['google-calendar', 'outlook-calendar'].includes(integration.provider_id)) refreshCalendarEventLabels(id);
    return updated;
  });
  ipcMain.handle('dashboard:set-integration-status', (_event, id, status) => Integration.setIntegrationStatus(id, status));
  ipcMain.handle('dashboard:set-workflow-enabled', (_event, id, enabled) => Workflow.setWorkflowEnabled(id, enabled));
  ipcMain.handle('dashboard:update-workflow-schedule', (_event, id, intervalMinutes) => Workflow.updateWorkflowSchedule(id, intervalMinutes));
  ipcMain.handle('dashboard:run-workflow', (_event, id) => executeWorkflow(id));
  ipcMain.handle('dashboard:connect-google-calendar', async (_event, { integrationId }) => {
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
    const id = integrationId || Integration.create({ provider_id: 'google-calendar', display_name: 'Google Calendar', account_label: connected.email || '', plugin_id: 'google-calendar-connector' }).id;
    try {
      const encrypted = (await safeStorage.encryptStringAsync(JSON.stringify(connected.token))).toString('base64');
      Integration.update(id, { config_json: JSON.stringify({ clientId: clientId.trim(), email: connected.email }), secret_blob: encrypted, account_label: existing?.account_label || connected.email || '', status: 'connected' });
      const calendars = await listGoogleCalendars(connected.token);
      const savedCalendars = saveProviderCalendars(id, calendars.map((calendar) => ({ id: calendar.id, summary: calendar.summary || calendar.id, timeZone: calendar.timeZone, backgroundColor: calendar.backgroundColor })));
      Integration.ensureCalendarSyncWorkflow(id);
      return { id, email: connected.email, accountLabel: existing?.account_label || '', calendars: savedCalendars };
    } catch (error) {
      Integration.update(id, { status: 'error' });
      throw new Error(`Google account connected, but calendar setup could not be loaded: ${error.message}`);
    }
  });
  ipcMain.handle('dashboard:sync-google-calendar', async (_event, id) => {
    const workflowId = Integration.find(id)?.sync_workflow_id;
    if (!workflowId) throw new Error('No sync workflow is attached to this Google Calendar connection.');
    return executeGoogleCalendarWorkflow(workflowId);
  });
  ipcMain.handle('dashboard:connect-outlook-calendar', async (_event, { integrationId }) => {
    const clientId = process.env.OUTLOOK_CALENDAR_CLIENT_ID;
    if (!clientId?.trim()) throw new Error('Set OUTLOOK_CALENDAR_CLIENT_ID in your environment or local .env file before connecting Outlook Calendar.');
    if (!await safeStorage.isAsyncEncryptionAvailable() || safeStorage.getSelectedStorageBackend?.() === 'basic_text') throw new Error('OS credential storage is unavailable. Set up your desktop keyring before connecting Outlook.');
    const existing = integrationId ? Integration.find(integrationId) : null;
    if (integrationId && (!existing || existing.provider_id !== 'outlook-calendar')) throw new Error('Outlook Calendar connection not found.');
    const connected = await connectOutlookCalendar({ clientId });
    if (!connected.token.refresh_token && existing?.secret_blob && JSON.parse(existing.config_json || '{}').clientId === clientId.trim()) {
      const previousToken = JSON.parse((await safeStorage.decryptStringAsync(Buffer.from(existing.secret_blob, 'base64'))).result);
      connected.token.refresh_token = previousToken.refresh_token;
    }
    if (!connected.token.refresh_token) throw new Error('Microsoft did not return a refresh token. Remove any old Local Dashboard consent and connect again.');
    const id = integrationId || Integration.create({ provider_id: 'outlook-calendar', display_name: 'Outlook Calendar', account_label: connected.email || '', plugin_id: 'outlook-calendar-connector' }).id;
    try {
      const encrypted = (await safeStorage.encryptStringAsync(JSON.stringify(connected.token))).toString('base64');
      Integration.update(id, { config_json: JSON.stringify({ clientId: clientId.trim(), email: connected.email }), secret_blob: encrypted, account_label: existing?.account_label || connected.email || '', status: 'connected' });
      const calendars = await listOutlookCalendars(connected.token);
      const savedCalendars = saveProviderCalendars(id, calendars.map((calendar) => ({ id: calendar.id, summary: calendar.name || calendar.id, timeZone: null, backgroundColor: calendar.hexColor || null })));
      Integration.ensureCalendarSyncWorkflow(id);
      return { id, email: connected.email, accountLabel: existing?.account_label || '', calendars: savedCalendars };
    } catch (error) {
      updateIntegrationSyncResult(id, 'error');
      throw new Error(`Outlook account connected, but calendar setup could not be loaded: ${error.message}`);
    }
  });
  ipcMain.handle('dashboard:sync-outlook-calendar', async (_event, id) => {
    const workflowId = Integration.find(id)?.sync_workflow_id;
    if (!workflowId) throw new Error('No sync workflow is attached to this Outlook connection.');
    return executeOutlookCalendarWorkflow(workflowId);
  });
  ipcMain.handle('dashboard:get-integration-calendars', (_event, id) => IntegrationCalendar.where({ integration_id: id }, {
    select: ['id', 'integration_id', 'external_calendar_id', 'summary', 'display_label', 'timezone', 'color', 'selected', 'last_sync_at', 'sync_window_start', 'sync_window_end'], orderBy: 'summary',
  }).map((calendar) => calendar.toJSON()));
  ipcMain.handle('dashboard:set-integration-calendars', (_event, id, selections) => IntegrationCalendar.setIntegrationCalendarSelection(id, selections));
  ipcMain.handle('dashboard:set-integration-calendar-color', (_event, id, color) => IntegrationCalendar.setDisplayColor(id, color));
  ipcMain.handle('dashboard:configure-calendar-integration', async (_event, id, { accountLabel, calendars }) => {
    const integration = Integration.find(id);
    if (!integration || !['google-calendar', 'outlook-calendar'].includes(integration.provider_id)) throw new Error('Calendar integration not found.');
    const config = JSON.parse(integration.config_json || '{}');
    Integration.update(id, { account_label: accountLabel?.trim() || config.email || '', status: 'connected' });
    IntegrationCalendar.setIntegrationCalendarSelection(id, calendars);
    refreshCalendarEventLabels(id);
    const workflowId = Integration.ensureCalendarSyncWorkflow(id);
    return integration.provider_id === 'google-calendar' ? executeGoogleCalendarWorkflow(workflowId) : executeOutlookCalendarWorkflow(workflowId);
  });
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
  const integrations = ApplicationRecord.query(`SELECT id, provider_id, display_name, account_label, status, plugin_id, sync_workflow_id, last_sync_at, config_json,
    secret_blob IS NOT NULL AS has_credentials,
    (SELECT COUNT(*) FROM integration_calendars c WHERE c.integration_id = integrations.id AND c.selected = 1) AS selected_calendar_count
    FROM integrations ORDER BY display_name, account_label`);
  const calendarsByIntegration = new Map();
  for (const calendar of ApplicationRecord.query(`SELECT id, integration_id, external_calendar_id, summary, display_label, color, selected
    FROM integration_calendars ORDER BY summary`)) {
    const calendars = calendarsByIntegration.get(calendar.integration_id) || [];
    calendars.push(calendar);
    calendarsByIntegration.set(calendar.integration_id, calendars);
  }
  return integrations.map((integration) => ({ ...integration, calendars: calendarsByIntegration.get(integration.id) || [] }));
}

function latestFinanceImportRun() {
  const row = ApplicationRecord.query(`SELECT r.id, r.status, r.started_at, r.finished_at, r.result_json, r.error_text
    FROM workflow_runs r WHERE r.workflow_id = ? ORDER BY r.started_at DESC, r.rowid DESC LIMIT 1`, financeStatementWorkflowId)[0];
  return row ? { ...row, result: row.result_json ? JSON.parse(row.result_json) : null } : null;
}

function getFinanceImportSession(importId) {
  const session = financeImportSessions.get(importId);
  if (!session) throw new Error('This import session expired. Choose the statement file again.');
  if (Date.now() - session.createdAt > 30 * 60 * 1000) { cancelFinanceImportSession(importId, session); throw new Error('This import session expired after 30 minutes. Choose the statement file again.'); }
  return session;
}

function commitFinanceImport(importId) {
  const session = getFinanceImportSession(importId);
  if (!session.preview) throw new Error('Preview the mapped rows before importing them.');
  const pageOffsets = Array.from({ length: Math.ceil(session.preview.rowCount / 100) }, (_value, index) => index * 100);
  if (pageOffsets.some((offset) => !session.reviewedPages.has(offset))) throw new Error('Review and confirm every preview page before importing.');
  try {
    Workflow.updateWorkflowRunProgress(session.workflowRunId, { stage: 'commit_records', filename: session.filename, validCount: session.preview.validCount });
    const batchId = randomUUID();
    const accountLabel = String(session.accountLabel || '').trim().slice(0, 80);
    const accepted = session.preview._normalizedRows.filter((row) => Object.hasOwn(session.rowOverrides, row.rowNumber)
      ? session.rowOverrides[row.rowNumber] : (session.keepPossibleDuplicates || !row.possibleDuplicate));
    const acceptedRowNumbers = new Set(accepted.map((row) => row.rowNumber));
    const skippedDuplicateCount = session.preview._normalizedRows.filter((row) => row.possibleDuplicate && !acceptedRowNumbers.has(row.rowNumber)).length;
    const excludedCount = session.preview.validCount - accepted.length - skippedDuplicateCount;
    const receipt = { stage: 'completed', filename: session.filename, batchId,
      importedCount: accepted.length, skippedDuplicateCount, excludedCount, invalidCount: session.preview.invalidCount,
      rowCount: session.preview.rowCount, accountLabel, currencyCodes: [...new Set(accepted.map((row) => row.currency))] };
    FinanceTransaction.transaction(() => {
      for (const row of accepted) {
        const id = `finance-import-${randomUUID()}`;
        const payload = {
          merchant: row.description,
          category: row.category || 'Uncategorized',
          amount: row.amount,
          direction: row.direction,
          currency: row.currency,
          postedAt: `${row.date}T12:00:00`,
          sourceName: 'Statement import',
          sourceFileName: session.filename,
          sourceRowNumber: row.rowNumber,
          importBatchId: batchId,
          importFingerprint: transactionFingerprint({ date: row.date, description: row.description, amount: row.amount, currency: row.currency, direction: row.direction, accountLabel }),
          accountLabel,
        };
        FinanceTransaction.create({ id, domain_id: 'personal-finance', record_type: 'finance_transactions', contract_version: 2,
          source_plugin_id: 'finance', external_id: id, occurred_at: payload.postedAt, payload_json: JSON.stringify(payload) });
      }
      Workflow.finishWorkflowRun(financeStatementWorkflowId, session.workflowRunId, receipt, null);
    });
    financeImportSessions.delete(importId);
    return receipt;
  } catch (error) {
    Workflow.finishWorkflowRun(financeStatementWorkflowId, session.workflowRunId, { stage: 'failed', filename: session.filename }, error.message);
    session.workflowRunId = Workflow.startWorkflowRun(financeStatementWorkflowId);
    Workflow.updateWorkflowRunProgress(session.workflowRunId, { stage: 'preview_rows', filename: session.filename, validCount: session.preview.validCount });
    throw error;
  }
}

function cancelFinanceImportSession(importId, session) {
  Workflow.finishWorkflowRun(financeStatementWorkflowId, session.workflowRunId, { stage: 'cancelled', filename: session.filename }, null, 'cancelled');
  financeImportSessions.delete(importId);
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

function refreshCalendarEventLabels(integrationId) {
  const calendars = ApplicationRecord.query(`SELECT c.external_calendar_id, COALESCE(NULLIF(c.display_label, ''), c.summary) AS calendar_name, i.plugin_id, i.account_label
    FROM integration_calendars c JOIN integrations i ON i.id = c.integration_id WHERE i.id = ?`, integrationId);
  for (const calendar of calendars) {
    const sourceName = calendar.account_label ? `${calendar.calendar_name} · ${calendar.account_label}` : calendar.calendar_name;
    const prefix = `calendar:${integrationId}:${calendar.external_calendar_id}:`;
    ApplicationRecord.execute(`UPDATE data_records SET payload_json = json_set(payload_json,
      '$.calendarName', ?, '$.sourceAccount', ?, '$.sourceName', ?)
      WHERE integration_id = ? AND source_plugin_id = ? AND substr(external_id, 1, length(?)) = ?`,
    calendar.calendar_name, calendar.account_label || '', sourceName, integrationId, calendar.plugin_id, prefix, prefix);
  }
}

function selectedCalendars(integrationId) {
  return ApplicationRecord.query(`SELECT c.id, c.integration_id, c.external_calendar_id, COALESCE(NULLIF(c.display_label, ''), c.summary) AS summary, c.timezone, c.color, c.sync_token, c.sync_window_start, c.sync_window_end, i.account_label
    FROM integration_calendars c JOIN integrations i ON i.id = c.integration_id
    WHERE c.integration_id = ? AND c.selected = 1 ORDER BY c.summary`, integrationId);
}

function workflowSummaries() {
  return ApplicationRecord.query(`SELECT w.id, w.plugin_id, w.integration_id, w.name, w.trigger_type, w.definition_json, w.enabled, w.next_run_at, w.last_run_at,
      i.display_name AS integration_name, i.status AS integration_status, p.name AS plugin_name
    FROM workflows w LEFT JOIN integrations i ON i.id = w.integration_id JOIN plugins p ON p.id = w.plugin_id ORDER BY w.created_at DESC`)
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
    // The color column is also the user's local display-color preference. Keep
    // it when provider metadata refreshes so custom colors survive each sync.
    updateColumns: ['summary', 'timezone'],
  });
  return IntegrationCalendar.where({ integration_id: integrationId }, {
    select: ['id', 'integration_id', 'external_calendar_id', 'summary', 'display_label', 'timezone', 'color', 'selected', 'last_sync_at', 'sync_window_start', 'sync_window_end'],
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
    minWidth: 320,
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
  Workflow.cancelRunningRuns(financeStatementWorkflowId, 'The app restarted before this statement import was confirmed. No staged rows were committed.');
  registerIpcHandlers();
  startWorkflowScheduler();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  for (const [id, session] of financeImportSessions) cancelFinanceImportSession(id, session);
  ApplicationRecord.disconnect();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
