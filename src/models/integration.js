const ApplicationRecord = require('./application-record');
const { Workflow } = require('./workflow');

class Integration extends ApplicationRecord {
  static get tableName() { return 'integrations'; }
  static get columns() { return ['id', 'provider_id', 'display_name', 'account_label', 'status', 'plugin_id', 'sync_workflow_id', 'last_sync_at', 'config_json', 'secret_blob']; }
  static get defaults() {
    return {
      id: () => `integration-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      account_label: '',
      status: 'setup_required',
    };
  }

  static setIntegrationStatus(id, status) {
    return this.transaction(() => {
      const workflow = this.connection.prepare('SELECT sync_workflow_id FROM integrations WHERE id = ?').get(id);
      const changes = this.connection.prepare("UPDATE integrations SET status = ? WHERE id = ?").run(status, id).changes;
      if (workflow?.sync_workflow_id) Workflow.setWorkflowEnabled(workflow.sync_workflow_id, status === 'connected');
      return changes > 0;
    });
  }
  static removeIntegration(id) {
    return this.transaction(() => {
      const integration = this.connection.prepare('SELECT provider_id FROM integrations WHERE id = ?').get(id);
      if (integration && ['google-calendar', 'outlook-calendar'].includes(integration.provider_id)) {
        // Imported calendar events belong to their connection. Once it is
        // removed they must not become indistinguishable from local events.
        this.connection.prepare("DELETE FROM data_records WHERE integration_id = ? AND record_type = 'calendar_events'").run(id);
      } else {
        // Keep non-calendar history (for example health metrics) locally when
        // its provider is disconnected.
        this.connection.prepare('UPDATE data_records SET integration_id = NULL WHERE integration_id = ?').run(id);
      }
      this.connection.prepare('UPDATE integrations SET sync_workflow_id = NULL WHERE id = ?').run(id);
      this.connection.prepare('DELETE FROM workflows WHERE integration_id = ?').run(id);
      const removed = this.connection.prepare('DELETE FROM integrations WHERE id = ?').run(id).changes > 0;
      return removed;
    });
  }
  static ensureFitbitWorkflow(integrationId) {
    const integration = this.connection.prepare('SELECT id, plugin_id, display_name, sync_workflow_id FROM integrations WHERE id = ?').get(integrationId);
    if (!integration) throw new Error('Integration not found.');
    if (integration.sync_workflow_id) {
      const workflow = this.connection.prepare('SELECT enabled FROM workflows WHERE id = ?').get(integration.sync_workflow_id);
      if (workflow && !workflow.enabled) Workflow.setWorkflowEnabled(integration.sync_workflow_id, true);
      return integration.sync_workflow_id;
    }
    const id = `workflow-fitbit-${integrationId}`;
    const intervalMinutes = 360;
    const nextRunAt = new Date(Date.now() + intervalMinutes * 60000).toISOString();
    const definition = { jobType: 'data_sync', providerId: 'fitbit', integrationId, intervalMinutes, stages: ['fetch_sleep', 'fetch_weight', 'normalize_health_records', 'upsert_sqlite'] };
    this.connection.prepare(`INSERT INTO workflows (id, plugin_id, integration_id, name, trigger_type, definition_json, enabled, next_run_at)
      VALUES (?, ?, ?, ?, 'schedule', ?, 1, ?)`)
      .run(id, integration.plugin_id, integrationId, `${integration.display_name} health sync`, JSON.stringify(definition), nextRunAt);
    this.connection.prepare('UPDATE integrations SET sync_workflow_id = ? WHERE id = ?').run(id, integrationId);
    return id;
  }
  static ensureCalendarSyncWorkflow(integrationId) {
    const integration = this.connection.prepare('SELECT id, provider_id, plugin_id, display_name, sync_workflow_id FROM integrations WHERE id = ?').get(integrationId);
    if (!integration) throw new Error('Integration not found.');
    if (integration.sync_workflow_id) {
      const workflow = this.connection.prepare('SELECT enabled FROM workflows WHERE id = ?').get(integration.sync_workflow_id);
      if (workflow && !workflow.enabled) Workflow.setWorkflowEnabled(integration.sync_workflow_id, true);
      return integration.sync_workflow_id;
    }
    const id = `workflow-calendar-${integrationId}`;
    const intervalMinutes = 360;
    const nextRunAt = new Date(Date.now() + intervalMinutes * 60000).toISOString();
    const definition = { jobType: 'data_sync', providerId: integration.provider_id, integrationId, intervalMinutes, stages: ['list_selected_calendars', 'incremental_event_sync', 'normalize_calendar_events', 'upsert_sqlite'] };
    this.connection.prepare(`INSERT INTO workflows (id, plugin_id, integration_id, name, trigger_type, definition_json, enabled, next_run_at)
      VALUES (?, ?, ?, ?, 'schedule', ?, 1, ?)`).run(id, integration.plugin_id, integrationId, `${integration.display_name} sync`, JSON.stringify(definition), nextRunAt);
    this.connection.prepare('UPDATE integrations SET sync_workflow_id = ? WHERE id = ?').run(id, integrationId);
    return id;
  }
}

module.exports = { Integration };
