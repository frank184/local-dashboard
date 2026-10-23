const { normalizeLocalDateTime } = require('./shared');

const ApplicationRecord = require('./application-record');

class TodoTask extends ApplicationRecord {
  static get tableName() { return 'data_records'; }
  static get columns() { return ['id', 'domain_id', 'record_type', 'contract_version', 'source_plugin_id', 'integration_id', 'external_id', 'occurred_at', 'payload_json']; }
  static get defaultScope() { return { record_type: 'todo_tasks' }; }
  static get defaultOrderBy() { return 'occurred_at'; }
  static get payloadColumn() { return 'payload_json'; }
  static get attributeBackings() { return { title: '_title', completed: '_completed', dueAt: '_dueAt' }; }
  static get defaults() {
    return {
      id: () => `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      domain_id: 'personal-productivity',
      record_type: 'todo_tasks',
      source_plugin_id: 'todos',
      external_id: (record) => record.id,
      category: 'personal',
      detail: '',
      completed: false,
    };
  }

  get title() { return this._title; }
  set title(value) { this._title = String(value ?? '').trim(); }

  get completed() { return this._completed; }
  set completed(value) { this._completed = Boolean(value); }

  get dueAt() { return this._dueAt; }
  set dueAt(value) { this._dueAt = value == null ? value : normalizeLocalDateTime(value); }

  validate() {
    if (!this.title) throw new Error('Task title is required.');
    if (!this.dueAt || !Number.isFinite(new Date(this.dueAt).getTime())) throw new Error('Enter a valid task due date and time.');
    if (this.record_type && this.record_type !== 'todo_tasks') throw new Error('TodoTask record_type must be todo_tasks.');
  }

  save() {
    this.validate();
    const current = this.id && this.connection.prepare("SELECT payload_json FROM data_records WHERE id = ? AND record_type = 'todo_tasks'").get(this.id);
    this.occurred_at = this.dueAt;
    const payload = {
      ...(current ? JSON.parse(current.payload_json) : {}),
      title: this.title,
      detail: this.detail,
      category: this.category,
      completed: this.completed,
      dueAt: this.dueAt,
    };
    this.payload_json = JSON.stringify(payload);
    if (current) {
      this.connection.prepare('UPDATE data_records SET occurred_at = ?, payload_json = ? WHERE id = ? AND record_type = \'todo_tasks\'').run(this.dueAt, this.payload_json, this.id);
    } else {
      this.connection.prepare(`INSERT INTO data_records (id, domain_id, record_type, source_plugin_id, external_id, occurred_at, payload_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(this.id, this.domain_id, this.record_type, this.source_plugin_id, this.external_id, this.dueAt, this.payload_json);
    }
    return this;
  }
}

module.exports = { TodoTask };
