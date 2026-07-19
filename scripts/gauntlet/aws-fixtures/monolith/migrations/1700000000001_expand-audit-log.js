/* Expand step (additive, safe): audit_log table + a legacy_flag column. */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('audit_log', {
    id: 'id',
    event: { type: 'text', notNull: true },
    at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addColumn('tasks', {
    legacy_flag: { type: 'boolean', notNull: false, default: false },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('tasks', 'legacy_flag');
  pgm.dropTable('audit_log');
};
