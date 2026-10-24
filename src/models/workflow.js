const ApplicationRecord = require('./application-record');

class Workflow extends ApplicationRecord {
  static get tableName() { return 'workflows'; }
  static get columns() { return ['id', 'plugin_id', 'integration_id', 'name', 'trigger_type', 'definition_json', 'enabled', 'created_at', 'next_run_at', 'last_run_at']; }
  static get jsonColumns() { return { definition_json: 'definition' }; }
  static setWorkflowEnabled(id, enabled) {
    const workflow = this.connection.prepare('SELECT definition_json, trigger_type FROM workflows WHERE id = ?').get(id);
    if (!workflow) return false;
    const definition = JSON.parse(workflow.definition_json);
    const nextRunAt = enabled && workflow.trigger_type === 'schedule' ? new Date(Date.now() + Number(definition.intervalMinutes || 360) * 60000).toISOString() : null;
    return this.connection.prepare('UPDATE workflows SET enabled = ?, next_run_at = ? WHERE id = ?').run(Number(enabled), nextRunAt, id).changes > 0;
  }
  static updateWorkflowSchedule(id, intervalMinutes) {
    const allowedIntervals = new Set([15, 30, 60, 180, 360, 720, 1440]);
    const interval = Number(intervalMinutes);
    if (!allowedIntervals.has(interval)) throw new Error('Choose a supported schedule interval.');
    const workflow = this.connection.prepare('SELECT definition_json, trigger_type, enabled FROM workflows WHERE id = ?').get(id);
    if (!workflow || workflow.trigger_type !== 'schedule') throw new Error('Only scheduled workflows have an editable interval.');
    const definition = JSON.parse(workflow.definition_json);
    definition.intervalMinutes = interval;
    const nextRunAt = workflow.enabled ? new Date(Date.now() + interval * 60000).toISOString() : null;
    return this.connection.prepare('UPDATE workflows SET definition_json = ?, next_run_at = ? WHERE id = ?')
      .run(JSON.stringify(definition), nextRunAt, id).changes > 0;
  }
  static startWorkflowRun(workflowId) {
    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.connection.prepare(`INSERT INTO workflow_runs (id, workflow_id, status, started_at) VALUES (?, ?, 'running', datetime('now'))`).run(runId, workflowId);
    return runId;
  }
  static updateWorkflowRunProgress(runId, result) {
    this.connection.prepare("UPDATE workflow_runs SET result_json = ? WHERE id = ? AND status = 'running'")
      .run(JSON.stringify(result), runId);
  }
  static finishWorkflowRun(workflowId, runId, result, error, finalStatus = null) {
    const workflow = this.connection.prepare('SELECT definition_json, enabled, trigger_type FROM workflows WHERE id = ?').get(workflowId);
    const intervalMinutes = workflow ? Number(JSON.parse(workflow.definition_json).intervalMinutes || 360) : 360;
    const nextRunAt = workflow?.enabled && workflow.trigger_type === 'schedule' ? new Date(Date.now() + intervalMinutes * 60000).toISOString() : null;
    this.connection.prepare(`UPDATE workflow_runs SET status = ?, finished_at = datetime('now'), result_json = ?, error_text = ? WHERE id = ?`)
      .run(finalStatus || (error ? 'failed' : 'succeeded'), result ? JSON.stringify(result) : null, error || null, runId);
    this.connection.prepare("UPDATE workflows SET last_run_at = datetime('now'), next_run_at = ? WHERE id = ?").run(nextRunAt, workflowId);
  }
  static cancelRunningRuns(workflowId, reason = 'The app closed before this local job finished.') {
    return this.connection.prepare(`UPDATE workflow_runs SET status = 'cancelled', finished_at = datetime('now'), error_text = ?
      WHERE workflow_id = ? AND status = 'running'`).run(reason, workflowId).changes;
  }
}

module.exports = { Workflow };
