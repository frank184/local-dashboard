/**
 * Base class for SQLite-backed models.
 *
 * Subclasses declare their table and writable columns, then inherit a small
 * synchronous CRUD API. Connect once during main-process startup:
 *
 *   const { ApplicationRecord, Plugin } = require('./models');
 *   ApplicationRecord.connect(database);
 *   const plugin = Plugin.find('calendar');
 *
 * A minimal model looks like:
 *
 *   class Note extends ApplicationRecord {
 *     static get tableName() { return 'notes'; }
 *     static get columns() { return ['id', 'title']; }
 *     validate() {
 *       if (!this.title?.trim()) throw new Error('Title is required.');
 *     }
 *   }
 */
class ApplicationRecord {
  static #connection = null;

  /**
   * Set the one SQLite connection shared by all model subclasses.
   * Call once after opening/migrating the database, before using models.
   * Passing a different connection while one is active throws.
   *
   * @example ApplicationRecord.connect(database);
   */
  static connect(connection) {
    if (!connection) throw new TypeError('A SQLite connection is required.');
    if (ApplicationRecord.#connection && ApplicationRecord.#connection !== connection) {
      throw new Error('ApplicationRecord is already connected. Disconnect it before replacing the connection.');
    }
    ApplicationRecord.#connection = connection;
  }

  /**
   * Close the shared SQLite connection and clear it. Call during application
   * shutdown; connecting again afterwards is allowed.
   *
   * @example ApplicationRecord.disconnect();
   */
  static disconnect() {
    ApplicationRecord.#connection?.close();
    ApplicationRecord.#connection = null;
  }

  /** Return the shared connection, throwing if connect() has not run yet. */
  static get connection() {
    if (!ApplicationRecord.#connection) throw new Error('ApplicationRecord has no database connection. Call connect() during app startup.');
    return ApplicationRecord.#connection;
  }

  /** Instance-level access to the same connection (usually for model methods). */
  get connection() { return this.constructor.connection; }

  /** Override with the SQLite table name used by this model. */
  static get tableName() {
    throw new Error(`${this.name} must define tableName.`);
  }

  /** Override only when the table's primary key is not `id`. */
  static get primaryKey() { return 'id'; }

  /** Override with the columns save() may insert/update for this model. */
  static get columns() { return []; }

  /**
   * Defaults applied by the base constructor when an attribute is omitted.
   * Values may be factories receiving the attributes accumulated so far;
   * declare dependent defaults after the values they use.
   *
   * @example
   * static get defaults() {
   *   return { id: () => createId(), enabled: 1, external_id: (record) => record.id };
   * }
   */
  static get defaults() { return {}; }

  /** Conditions applied to ordinary reads and writes for this model. */
  static get defaultScope() { return {}; }
  static get defaultOrderBy() { return null; }

  /** JSON column to decode when constructing records backed by a JSON payload. */
  static get payloadColumn() { return null; }
  static get jsonColumns() { return {}; }

  /** Execute a parameterized SQL query and return its rows. Use for joins and aggregates. */
  static query(sql, ...bindings) { return this.connection.prepare(sql).all(...bindings); }

  /** Execute a parameterized INSERT, UPDATE, or DELETE and return its result. */
  static execute(sql, ...bindings) { return this.connection.prepare(sql).run(...bindings); }

  static attributesFor(row) {
    const attributes = { ...row };
    for (const [column, alias] of Object.entries(this.jsonColumns)) {
      if (attributes[column]) attributes[alias] = JSON.parse(attributes[column]);
    }
    if (this.payloadColumn && attributes[this.payloadColumn]) {
      Object.assign(attributes, JSON.parse(attributes[this.payloadColumn]));
    }
    return attributes;
  }

  static instantiate(row) {
    return Object.assign(Object.create(this.prototype), this.attributesFor(row));
  }

  static assertColumn(column) {
    if (!this.columns.includes(column)) throw new Error(`${column} is not a column of ${this.name}.`);
  }

  static conditions(criteria = {}) {
    const merged = { ...criteria, ...this.defaultScope };
    const clauses = [];
    const values = [];
    for (const [column, condition] of Object.entries(merged)) {
      this.assertColumn(column);
      if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
        if ('$in' in condition) {
          const list = condition.$in;
          if (!Array.isArray(list)) throw new TypeError(`${column} $in must be an array.`);
          if (!list.length) clauses.push('0 = 1');
          else { clauses.push(`${column} IN (${list.map(() => '?').join(', ')})`); values.push(...list); }
        } else if ('$ne' in condition) {
          clauses.push(`${column} != ?`); values.push(condition.$ne);
        } else if ('$like' in condition) {
          clauses.push(`${column} LIKE ?`); values.push(condition.$like);
        } else throw new TypeError(`Unsupported condition for ${column}.`);
      } else {
        clauses.push(`${column} = ?`); values.push(condition);
      }
    }
    return { sql: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '', values };
  }

  /** Find records matching column conditions; supports $in/$ne, selected columns, ordering, and limit. */
  static where(criteria = {}, { select = this.columns, orderBy, limit } = {}) {
    for (const column of select) this.assertColumn(column);
    let sql = `SELECT ${select.join(', ')} FROM ${this.tableName}${this.conditions(criteria).sql}`;
    const { values } = this.conditions(criteria);
    orderBy ||= this.defaultOrderBy;
    if (orderBy) {
      const orders = Array.isArray(orderBy) ? orderBy : [orderBy];
      sql += ` ORDER BY ${orders.map((entry) => {
        const column = typeof entry === 'string' ? entry : entry.column;
        const direction = typeof entry === 'string' ? 'ASC' : String(entry.direction || 'ASC').toUpperCase();
        this.assertColumn(column);
        if (!['ASC', 'DESC'].includes(direction)) throw new TypeError('Order direction must be ASC or DESC.');
        return `${column} ${direction}`;
      }).join(', ')}`;
    }
    if (limit !== undefined) {
      if (!Number.isInteger(limit) || limit < 0) throw new TypeError('Limit must be a non-negative integer.');
      sql += ' LIMIT ?'; values.push(limit);
    }
    return this.connection.prepare(sql).all(...values).map((row) => this.instantiate(row));
  }

  /**
   * Build a model instance from an attribute object, filling any omitted
   * attributes from the model's static defaults declaration.
   * ApplicationRecord itself is abstract; instantiate a subclass instead.
   *
   * @example const plugin = new Plugin({ id: 'calendar', name: 'Calendar' }); // model defaults fill other fields
   */
  constructor(attributes = {}) {
    if (new.target === ApplicationRecord) throw new TypeError('ApplicationRecord is abstract. Instantiate a model subclass.');
    const values = { ...attributes };
    for (const [name, fallback] of Object.entries(this.constructor.defaults)) {
      if (values[name] === undefined) values[name] = typeof fallback === 'function' ? fallback(values) : fallback;
    }
    Object.assign(this, values);
  }

  /**
   * Validate before save(). Return false to reject with a generic error, or
   * throw a specific error for a useful validation message. Subclasses should
   * override this when their records have domain rules.
   *
   * @example
   * validate() {
   *   if (!this.name?.trim()) throw new Error('Name is required.');
   * }
   */
  validate() { return true; }

  /**
   * Lifecycle hook called by save() when it is about to insert a new row.
   * Override for behavior that must happen for every creation path, including
   * Model.create() and `new Model(attrs).save()`.
   *
   * @example
   * beforeCreate() {
   *   if (!this.id) this.id = makeUniqueSlug(this.name);
   * }
   */
  beforeCreate() {}

  /**
   * Insert this record if its primary key is new, otherwise update its row.
   * The model must declare tableName and columns; the primary key is required.
   * Returns this record to allow chaining. Domain models backed by generic
   * data_records may override this to preserve their record type and payload.
   *
   * @example const savedPlugin = new Plugin(attributes).save();
   */
  save() {
    const Model = this.constructor;
    const columns = Model.columns;
    if (!Model.tableName || !columns.length) throw new Error(`${Model.name} must define tableName and columns to use save().`);
    let primaryKey = this[Model.primaryKey];
    let exists = primaryKey != null && Model.connection.prepare(`SELECT 1 FROM ${Model.tableName} WHERE ${Model.primaryKey} = ?`).get(primaryKey);
    if (!exists) {
      this.beforeCreate();
      primaryKey = this[Model.primaryKey];
      exists = primaryKey != null && Model.connection.prepare(`SELECT 1 FROM ${Model.tableName} WHERE ${Model.primaryKey} = ?`).get(primaryKey);
    }
    if (primaryKey == null || primaryKey === '') throw new Error(`${Model.name} requires ${Model.primaryKey}.`);
    if (this.validate() === false) throw new Error(`${Model.name} failed validation.`);
    const values = columns.filter((column) => column !== Model.primaryKey && this[column] !== undefined);
    if (exists) {
      if (values.length) {
        const assignments = values.map((column) => `${column} = ?`).join(', ');
        Model.connection.prepare(`UPDATE ${Model.tableName} SET ${assignments} WHERE ${Model.primaryKey} = ?`)
          .run(...values.map((column) => this[column]), primaryKey);
      }
    } else {
      const insertColumns = [Model.primaryKey, ...values];
      const placeholders = insertColumns.map(() => '?').join(', ');
      Model.connection.prepare(`INSERT INTO ${Model.tableName} (${insertColumns.join(', ')}) VALUES (${placeholders})`)
        .run(primaryKey, ...values.map((column) => this[column]));
    }
    return this;
  }

  /** Assign attributes and persist them with save(); returns this record.
   * @example plugin.update({ name: 'Calendar' });
   */
  update(attributes) {
    Object.assign(this, attributes);
    return this.save();
  }

  /** Delete this row by primary key; returns true when a row was removed.
   * @example plugin.delete();
   */
  delete() { return this.constructor.delete(this[this.constructor.primaryKey]); }

  /** Construct and save a record, applying defaults and beforeCreate();
   * returns the saved model instance.
   * @example const plugin = Plugin.create(attributes);
   */
  static create(attributes) { return new this(attributes).save(); }

  /** Find by primary key, update if present, and return the model or null.
   * @example const plugin = Plugin.update('calendar', { enabled: 1 });
   */
  static update(id, attributes) {
    const record = this.find(id);
    return record ? record.update(attributes) : null;
  }

  /** Find one row by primary key; returns a model instance or null.
   * @example const plugin = Plugin.find('calendar');
   */
  static find(id) { return this.where({ [this.primaryKey]: id }, { limit: 1 })[0] || null; }

  /** Return every row as an instance of this model.
   * @example const plugins = Plugin.all();
   */
  static all(options = {}) { return this.where({}, options); }

  /** Delete by primary key; returns true when a row was removed.
   * @example const removed = Plugin.delete('calendar');
   */
  static delete(id) {
    const { sql, values } = this.conditions({ [this.primaryKey]: id });
    return this.connection.prepare(`DELETE FROM ${this.tableName}${sql}`).run(...values).changes > 0;
  }

  /** Delete every matching record while retaining the model's default scope. */
  static deleteWhere(criteria = {}) {
    const { sql, values } = this.conditions(criteria);
    return this.connection.prepare(`DELETE FROM ${this.tableName}${sql}`).run(...values).changes;
  }

  /** Insert or update a batch using a declared unique constraint, atomically. */
  static upsertAll(records, { uniqueBy, updateColumns }) {
    if (!Array.isArray(records)) throw new TypeError('upsertAll expects an array of records.');
    if (!records.length) return 0;
    if (!Array.isArray(uniqueBy) || !uniqueBy.length || !Array.isArray(updateColumns)) throw new TypeError('upsertAll requires uniqueBy and updateColumns arrays.');
    const instances = records.map((record) => record instanceof this ? record : new this(record));
    const fields = this.columns.filter((column) => instances.some((record) => record[column] !== undefined));
    for (const column of [...uniqueBy, ...updateColumns]) this.assertColumn(column);
    const placeholders = fields.map(() => '?').join(', ');
    const conflict = uniqueBy.join(', ');
    const update = updateColumns.map((column) => `${column} = excluded.${column}`).join(', ');
    const sql = `INSERT INTO ${this.tableName} (${fields.join(', ')}) VALUES (${placeholders}) ON CONFLICT(${conflict}) DO ${update ? `UPDATE SET ${update}` : 'NOTHING'}`;
    const statement = this.connection.prepare(sql);
    return this.transaction(() => instances.reduce((count, record) => count + statement.run(...fields.map((field) => record[field] ?? null)).changes, 0));
  }

  /** Plain attributes for IPC and JSON serialization. */
  toJSON() { return { ...this }; }

  /**
   * Run synchronous model/database work atomically. Commits the callback result,
   * or rolls back and rethrows if the callback fails. Do not return a Promise:
   * this wrapper commits as soon as the callback returns.
   *
   * @example
   * Plugin.transaction(() => {
   *   Plugin.update('calendar', { enabled: 0 });
   *   Workflow.update('calendar-sync', { enabled: 0 });
   * });
   */
  static transaction(callback) {
    this.connection.exec('BEGIN');
    try {
      const result = callback();
      this.connection.exec('COMMIT');
      return result;
    } catch (error) {
      this.connection.exec('ROLLBACK');
      throw error;
    }
  }
}

module.exports = ApplicationRecord;
