const ApplicationRecord = require('./application-record');

class HealthMetric extends ApplicationRecord {
  static get tableName() { return 'data_records'; }
  static get columns() { return ['id', 'domain_id', 'record_type', 'contract_version', 'source_plugin_id', 'integration_id', 'external_id', 'occurred_at', 'payload_json']; }
  static get defaultScope() { return { record_type: { $in: ['health_sleep', 'health_weight'] } }; }
  static get defaultOrderBy() { return 'occurred_at'; }
  static get payloadColumn() { return 'payload_json'; }

  validate() {
    if (this.record_type && !['health_sleep', 'health_weight'].includes(this.record_type)) throw new Error('Unsupported health metric type.');
    if (this.payload_json) JSON.parse(this.payload_json);
  }

}

module.exports = { HealthMetric };
