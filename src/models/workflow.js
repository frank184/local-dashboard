const ApplicationRecord = require('./application-record');

class Workflow extends ApplicationRecord {
  static get tableName() { return 'workflows'; }
  static get columns() { return ['id', 'plugin_id', 'integration_id', 'name', 'trigger_type', 'definition_json', 'enabled', 'created_at', 'next_run_at', 'last_run_at']; }
  static get jsonColumns() { return { definition_json: 'definition' }; }
  static setWorkflowEnabled(id, enabled) {
    const workflow = this.connection.prepare('SELECT definition_json FROM workflows WHERE id = ?').get(id);
    if (!workflow) return false;
    const definition = JSON.parse(workflow.definition_json);
    const nextRunAt = enabled ? new Date(Date.now() + Number(definition.intervalMinutes || 360) * 60000).toISOString() : null;
    return this.connection.prepare('UPDATE workflows SET enabled = ?, next_run_at = ? WHERE id = ?').run(Number(enabled), nextRunAt, id).changes > 0;
  }
  static startWorkflowRun(workflowId) {
    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.connection.prepare(`INSERT INTO workflow_runs (id, workflow_id, status, started_at) VALUES (?, ?, 'running', datetime('now'))`).run(runId, workflowId);
    return runId;
  }
  static finishWorkflowRun(workflowId, runId, result, error) {
    const workflow = this.connection.prepare('SELECT definition_json, enabled FROM workflows WHERE id = ?').get(workflowId);
    const intervalMinutes = workflow ? Number(JSON.parse(workflow.definition_json).intervalMinutes || 360) : 360;
    const nextRunAt = workflow?.enabled ? new Date(Date.now() + intervalMinutes * 60000).toISOString() : null;
    this.connection.prepare(`UPDATE workflow_runs SET status = ?, finished_at = datetime('now'), result_json = ?, error_text = ? WHERE id = ?`)
      .run(error ? 'failed' : 'succeeded', result ? JSON.stringify(result) : null, error || null, runId);
    this.connection.prepare("UPDATE workflows SET last_run_at = datetime('now'), next_run_at = ? WHERE id = ?").run(nextRunAt, workflowId);
  }
}

module.exports = { Workflow };
