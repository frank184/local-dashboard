const ApplicationRecord = require('./application-record');

class Plugin extends ApplicationRecord {
  static get tableName() { return 'plugins'; }
  static get columns() { return ['id', 'name', 'version', 'domain_id', 'kind', 'enabled', 'installed_at', 'manifest_json', 'description', 'icon', 'installed']; }
  static get defaults() {
    return {
      version: '0.1.0',
      kind: 'feature',
      enabled: 1,
      manifest_json: JSON.stringify({ contributes: [], ui: { type: 'placeholder' } }),
      description: '',
      icon: 'blocks',
      installed: 1,
    };
  }

  validate() {
    if (!this.name?.trim()) throw new Error('Plugin name is required.');
    if (!this.domain_id) throw new Error('Plugin domain is required.');
    if (!['source', 'feature', 'orchestration'].includes(this.kind)) throw new Error('Plugin kind is invalid.');
  }

  beforeCreate() {
    if (this.id) return;
    const base = this.name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 42) || 'plugin';
    let id = base;
    let suffix = 2;
    while (this.connection.prepare('SELECT 1 FROM plugins WHERE id = ?').get(id)) id = `${base}-${suffix++}`;
    this.id = id;
  }

  static uninstallPlugin(id) {
    if (!this.connection.prepare('SELECT id FROM plugins WHERE id = ?').get(id)) return false;
    return this.transaction(() => {
      this.connection.prepare('UPDATE data_records SET source_plugin_id = NULL WHERE source_plugin_id = ?').run(id);
      this.connection.prepare('UPDATE integrations SET status = \'paused\' WHERE plugin_id = ?').run(id);
      this.connection.prepare('UPDATE workflows SET enabled = 0 WHERE plugin_id = ?').run(id);
      this.connection.prepare('UPDATE plugins SET installed = 0, enabled = 0 WHERE id = ?').run(id);
      return true;
    });
  }
  static installPlugin(id) {
    return this.connection.prepare("UPDATE plugins SET installed = 1, enabled = 1 WHERE id = ? AND kind != 'source'").run(id).changes > 0;
  }
}

module.exports = { Plugin };
