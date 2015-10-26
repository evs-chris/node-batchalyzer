this.up = function*(t) {
  yield t.nonQuery('alter table orders add column on_demand boolean not null default false;');
};

this.down = function*(t) {
  yield t.nonQuery('alter table orders drop column on_demand;');
};
