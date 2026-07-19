/* Contract step of expand-then-contract: remove the legacy flag now that
 * nothing reads it. Intentionally uses raw destructive SQL so PlainOps'
 * migration lint must flag this file before anything runs. */
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql('ALTER TABLE tasks DROP COLUMN IF EXISTS legacy_flag');
};

exports.down = (pgm) => {
  pgm.sql('ALTER TABLE tasks ADD COLUMN legacy_flag boolean DEFAULT false');
};
