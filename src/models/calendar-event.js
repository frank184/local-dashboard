const ApplicationRecord = require('./application-record');

class CalendarEvent extends ApplicationRecord {
  static get tableName() { return 'data_records'; }
  static get columns() { return ['id', 'domain_id', 'record_type', 'contract_version', 'source_plugin_id', 'integration_id', 'external_id', 'occurred_at', 'payload_json']; }
  static get defaultScope() { return { record_type: 'calendar_events' }; }
  static get defaultOrderBy() { return 'occurred_at'; }
  static get payloadColumn() { return 'payload_json'; }
  static get attributeBackings() { return { title: '_title', allDay: '_allDay' }; }
  static get defaults() {
    return {
      id: () => `event-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      domain_id: 'personal-productivity',
      record_type: 'calendar_events',
      contract_version: 2,
      source_plugin_id: 'calendar',
      external_id: (record) => record.id,
      integration_id: null,
      description: '',
      location: '',
      category: 'personal',
      calendarId: 'local',
      allDay: false,
      color: 'green',
    };
  }

  get title() { return this._title; }
  set title(value) { this._title = String(value ?? '').trim(); }

  get allDay() { return this._allDay; }
  set allDay(value) { this._allDay = Boolean(value); }

  validate() {
    if (!this.title) throw new Error('Event title is required.');
    if (!this.startAt || !Number.isFinite(new Date(this.startAt).getTime())) throw new Error('Enter a valid event date and time.');
    if (this.record_type && this.record_type !== 'calendar_events') throw new Error('CalendarEvent record_type must be calendar_events.');
  }

  save() {
    this.validate();
    const current = this.id && this.connection.prepare("SELECT payload_json FROM data_records WHERE id = ? AND record_type = 'calendar_events'").get(this.id);
    this.occurred_at = this.startAt;
    const payload = {
      ...(current ? JSON.parse(current.payload_json) : {}),
      title: this.title,
      detail: this.description,
      description: this.description,
      location: this.location,
      category: this.category,
      startAt: this.startAt,
      endAt: this.endAt,
      calendarId: this.calendarId,
      allDay: this.allDay,
      color: this.color,
    };
    this.payload_json = JSON.stringify(payload);
    if (current) {
      this.connection.prepare("UPDATE data_records SET occurred_at = ?, payload_json = ? WHERE id = ? AND record_type = 'calendar_events'").run(this.occurred_at, this.payload_json, this.id);
    } else {
      const fields = ['id', 'domain_id', 'record_type', 'contract_version', 'source_plugin_id', 'integration_id', 'external_id', 'occurred_at', 'payload_json'];
      this.connection.prepare(`INSERT INTO data_records (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`).run(...fields.map((field) => this[field]));
    }
    return this;
  }

}

module.exports = { CalendarEvent };
