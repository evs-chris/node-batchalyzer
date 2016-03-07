this.up = function*(t) {
  yield t.nonQuery('alter table entries add column deleted_at timestamptz;');
};

this.down = function*(t) {
  yield t.nonQuery('alter table entries drop column deleted_at;');
};

