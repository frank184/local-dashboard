const ApplicationRecord = require('./application-record');

class IntegrationCalendar extends ApplicationRecord {
  static get tableName() { return 'integration_calendars'; }
  static get columns() { return ['id', 'integration_id', 'external_calendar_id', 'summary', 'timezone', 'color', 'selected', 'sync_token', 'sync_window_start', 'sync_window_end', 'last_sync_at']; }
  static get defaults() {
    return {
      id: (record) => `gcal-${record.integration_id}-${Buffer.from(record.external_calendar_id).toString('base64url')}`,
      selected: 1,
      timezone: null,
      color: null,
      sync_token: null,
      sync_window_start: null,
      sync_window_end: null,
      last_sync_at: null,
    };
  }
  static setIntegrationCalendarSelection(integrationId, selections) {
    const update = this.connection.prepare('UPDATE integration_calendars SET selected = ? WHERE integration_id = ? AND id = ?');
    this.transaction(() => {
      for (const item of selections) {
        update.run(Number(Boolean(item.selected)), integrationId, item.id);
        if (!item.selected) {
          this.connection.prepare('UPDATE integration_calendars SET sync_token = NULL, sync_window_start = NULL, sync_window_end = NULL WHERE integration_id = ? AND id = ?').run(integrationId, item.id);
          const calendar = this.connection.prepare(`SELECT c.external_calendar_id, i.plugin_id FROM integration_calendars c
            JOIN integrations i ON i.id = c.integration_id WHERE c.integration_id = ? AND c.id = ?`).get(integrationId, item.id);
          if (calendar) this.connection.prepare(`DELETE FROM data_records WHERE integration_id = ? AND source_plugin_id = ? AND external_id LIKE ?`).run(integrationId, calendar.plugin_id, `calendar:${integrationId}:${calendar.external_calendar_id}:%`);
        }
      }
    });
    return true;
  }
}

module.exports = { IntegrationCalendar };
