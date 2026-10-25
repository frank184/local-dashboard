const ApplicationRecord = require('./application-record');

class IntegrationCalendar extends ApplicationRecord {
  static get tableName() { return 'integration_calendars'; }
  static get columns() { return ['id', 'integration_id', 'external_calendar_id', 'summary', 'display_label', 'timezone', 'color', 'selected', 'sync_token', 'sync_window_start', 'sync_window_end', 'last_sync_at']; }
  static get defaults() {
    return {
      id: (record) => `gcal-${record.integration_id}-${Buffer.from(record.external_calendar_id).toString('base64url')}`,
      selected: 1,
      display_label: null,
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
    const updateLabel = this.connection.prepare('UPDATE integration_calendars SET display_label = ? WHERE integration_id = ? AND id = ?');
    this.transaction(() => {
      for (const item of selections) {
        update.run(Number(Boolean(item.selected)), integrationId, item.id);
        if (Object.hasOwn(item, 'displayLabel')) updateLabel.run(item.displayLabel?.trim() || null, integrationId, item.id);
        const calendar = this.connection.prepare(`SELECT c.external_calendar_id, c.summary, c.display_label, i.plugin_id, i.account_label FROM integration_calendars c
          JOIN integrations i ON i.id = c.integration_id WHERE c.integration_id = ? AND c.id = ?`).get(integrationId, item.id);
        if (Object.hasOwn(item, 'displayLabel') && calendar) {
          const calendarName = calendar.display_label || calendar.summary;
          const sourceName = calendar.account_label ? `${calendarName} · ${calendar.account_label}` : calendarName;
          const prefix = `calendar:${integrationId}:${calendar.external_calendar_id}:`;
          this.connection.prepare(`UPDATE data_records SET payload_json = json_set(payload_json,
            '$.calendarName', ?, '$.sourceAccount', ?, '$.sourceName', ?)
            WHERE integration_id = ? AND source_plugin_id = ? AND substr(external_id, 1, length(?)) = ?`)
            .run(calendarName, calendar.account_label || '', sourceName, integrationId, calendar.plugin_id, prefix, prefix);
        }
        if (!item.selected) {
          this.connection.prepare('UPDATE integration_calendars SET sync_token = NULL, sync_window_start = NULL, sync_window_end = NULL WHERE integration_id = ? AND id = ?').run(integrationId, item.id);
          if (calendar) {
            const prefix = `calendar:${integrationId}:${calendar.external_calendar_id}:`;
            this.connection.prepare(`DELETE FROM data_records WHERE integration_id = ? AND source_plugin_id = ? AND substr(external_id, 1, length(?)) = ?`).run(integrationId, calendar.plugin_id, prefix, prefix);
          }
        }
      }
    });
    return true;
  }

  static setDisplayColor(calendarId, color) {
    const allowed = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink'];
    if (!allowed.includes(color)) throw new Error('Choose a color from the calendar palette.');
    const result = this.connection.prepare('UPDATE integration_calendars SET color = ? WHERE id = ?').run(color, calendarId);
    if (!result.changes) throw new Error('Calendar not found.');
    return true;
  }
}

module.exports = { IntegrationCalendar };
