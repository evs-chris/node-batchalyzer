this.up = function*(trans) {
  var prefix = config.prefix || '';
  var script = `
create table commands (
  id bigserial primary key,
  name varchar not null,
  version integer not null default 1,
  label varchar not null,
  files json not null default '[]', -- array of files { name, content, mode = '0755', encoding = 'utf8' }
  init json not null default '[]', -- array af commands { cmd, args, result = [0] } where result is a list of ok return codes
  created_at timestamptz not null default CURRENT_TIMESTAMP(3),
  updated_at timestamptz not null default CURRENT_TIMESTAMP(3)
);
`;

  yield trans.nonQuery(script);
};

this.down = function*(trans) {
  var prefix = config.prefix || '';
  var script = `drop table ${prefix}commands;`;

  yield trans.nonQuery(script);
};
