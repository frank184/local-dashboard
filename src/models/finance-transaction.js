const ApplicationRecord = require('./application-record');
const { randomUUID } = require('node:crypto');

class FinanceTransaction extends ApplicationRecord {
  static get tableName() { return 'data_records'; }
  static get columns() { return ['id', 'domain_id', 'record_type', 'contract_version', 'source_plugin_id', 'external_id', 'occurred_at', 'payload_json']; }
  static get defaultScope() { return { domain_id: 'personal-finance', record_type: 'finance_transactions' }; }
  static get defaultOrderBy() { return { column: 'occurred_at', direction: 'DESC' }; }
  static get payloadColumn() { return 'payload_json'; }

  static clearSamples() {
    return this.deleteWhere({ source_plugin_id: 'finance', external_id: { $like: 'sample-finance-%' } });
  }

  static createLocal({ merchant, category, amount, direction, occurredAt, currency = 'CAD' }) {
    const cleanMerchant = String(merchant || '').trim();
    const cleanCategory = String(category || '').trim();
    const value = Number(amount);
    const cleanDirection = direction === 'income' ? 'income' : 'expense';
    const cleanCurrency = String(currency || 'CAD').trim().toUpperCase();
    if (!cleanMerchant || cleanMerchant.length > 100) throw new Error('Enter a merchant or description (up to 100 characters).');
    if (!cleanCategory || cleanCategory.length > 40) throw new Error('Choose a category.');
    if (!Number.isFinite(value) || value <= 0 || value > 100000000) throw new Error('Enter an amount greater than zero.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(occurredAt || ''))) throw new Error('Choose a valid transaction date.');
    if (!/^[A-Z]{3}$/.test(cleanCurrency)) throw new Error('Enter a three-letter currency code.');
    const id = `finance-local-${randomUUID()}`;
    const payload = { merchant: cleanMerchant, category: cleanCategory, amount: Number(value.toFixed(2)), direction: cleanDirection, currency: cleanCurrency, postedAt: `${occurredAt}T12:00:00`, sourceName: 'Added on this device' };
    this.create({ id, domain_id: 'personal-finance', record_type: 'finance_transactions', contract_version: 2, source_plugin_id: 'finance', external_id: id, occurred_at: payload.postedAt, payload_json: JSON.stringify(payload) });
    return id;
  }
}

module.exports = { FinanceTransaction };
