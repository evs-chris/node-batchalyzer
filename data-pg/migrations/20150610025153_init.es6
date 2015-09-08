this.up = function*(trans) {
  var prefix = config.prefix || '';
  var script = `
-- definitions for a unit of work - these get scheduled via entries
create table ${prefix}jobs (
  id bigserial primary key,
  custom_id varchar, -- used for linking to jobs externally
  name varchar not null,
  priority integer not null default 1,
  config json not null default '{}', -- primary configuration for the job - allowed agents (group) - execution config e.g. remote command, script, etc
  created_at timestamptz not null default CURRENT_TIMESTAMP(3),
  updated_at timestamptz not null default CURRENT_TIMESTAMP(3)
);

-- actual scheduled jobs go here
create table ${prefix}entries (
  id bigserial primary key,
  custom_id varchar, -- used for linking to scheduled things externally
  job_id bigint references ${prefix}jobs(id), -- entries may not have a job if they're one-off, like a custom third-party upload
  schedule json not null default '{}', -- json object with schedule definition (CRON, interval, wait-between, date-CRON time-interval combo, triggered/demand?, etc)
  config json not null default '{}', -- secondary config, which will be merged with primary if there is one
  last_run timestamptz,
  priority integer not null default 1, -- higher priority gets access to resources first
  created_at timestamptz not null default CURRENT_TIMESTAMP(3),
  updated_at timestamptz not null default CURRENT_TIMESTAMP(3)
);

-- a schedule is a group of orderings - used to post conditions within a schedule in case there is overlap
create table ${prefix}schedules (
  id bigserial primary key,
  name varchar not null default now()::date::varchar,
  active boolean not null default true, -- when all jobs complete, goes to false
  target date not null default now(),
  conditions json not null default '{}',
  created_at timestamptz not null default CURRENT_TIMESTAMP(3),
  updated_at timestamptz not null default CURRENT_TIMESTAMP(3)
);

-- each entry can be ordered a number of times
create table ${prefix}orders (
  id bigserial primary key,
  entry_id bigint not null references ${prefix}entries(id),
  schedule_id bigint not null references ${prefix}schedules(id),
  agent_id bigint references ${prefix}agents(id), -- set after dispatch
  result integer, -- return code from actual job
  status integer not null default -1, -- 0 ok, -1 pending schedule, -2 pending resource, 1 failed, 2 soft failed, 3 cancelled, 4 unknown, 10 running
  steps json not null default '[]', -- jobs may emit step events to update progress
  held boolean not null default false,
  eligible_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default CURRENT_TIMESTAMP(3),
  updated_at timestamptz not null default CURRENT_TIMESTAMP(3)
);

-- resources pools
create table ${prefix}resources (
  id bigserial primary key,
  name varchar not null,
  type integer not null default 0, -- 0 standard, 1 rate limit, 2 both?
  total integer,
  used integer,
  rate integer[], -- ratelimit resource, this is an array of hits that gets cleaned as it goes
  max_per_minute integer, -- maximum rate
  created_at timestamptz not null default CURRENT_TIMESTAMP(3),
  updated_at timestamptz not null default CURRENT_TIMESTAMP(3)
);

-- connected (and disconnected) agents
create table ${prefix}agents (
  id bigserial primary key,
  name varchar not null,
  key varchar not null, -- for auth
  config json not null default '{}', -- agent config -- probably define submodules to be pulled to agent here
  label varchar,
  status integer, -- 0 not connected, 1 connected, 2 stale, -1 offline on purpose
  groups varchar[] not null default ARRAY[]::varchar[],
  location varchar, -- ip connected from
  last_seen timestamptz,
  created_at timestamptz not null default CURRENT_TIMESTAMP(3),
  updated_at timestamptz not null default CURRENT_TIMESTAMP(3)
);

create table ${prefix}stat_definitions (
  id bigserial primary key,
  name varchar not null,
  type varchar not null, -- mem, load, fork, etc
  config json not null default '{}', -- holds schedule, retry count, retry wait, timeout, etc
  warning double precision, -- default to 10minutes for first run jobs
  critical double precision, -- default to 4 hours for first run jobs
  created_at timestamptz not null default CURRENT_TIMESTAMP(3),
  updated_at timestamptz not null default CURRENT_TIMESTAMP(3)
);

-- available memory, network bandwidth, disk free, job runtime, etc
create table ${prefix}stats (
  id bigserial primary key,
  definition_id bigint references ${prefix}stats(id),
  agent_id bigint references ${prefix}agents(id),
  order_id bigint references ${prefix}orders(id),
  config json not null default '{}', -- definition override
  type integer not null default 0, -- 0 stat, 1 job time
  state integer not null default 0, -- 0 ok, 1 warn, 2 crit
  created_at timestamptz not null default CURRENT_TIMESTAMP(3),
  updated_at timestamptz not null default CURRENT_TIMESTAMP(3)
);

-- collected statistics
create table ${prefix}stat_entries (
  stat_id bigint not null references ${prefix}stats(id),
  value double precision not null, -- numeric value of stat
  status varchar, -- freeform status message with details a la nagios
  created_at timestamptz not null default CURRENT_TIMESTAMP(3)
);

create table ${prefix}output (
  id bigserial primary key,
  order_id bigint not null references ${prefix}orders(id),
  sysout text not null default '', -- sysout should be periodically flushed
  syserr text not null default '', -- syserr should be periodically flushed
  created_at timestamptz not null default CURRENT_TIMESTAMP(3),
  updated_at timestamptz not null default CURRENT_TIMESTAMP(3)
);

-- messages emitted by jobs/scheduler/stats/agents
create table ${prefix}messages (
  id bigserial primary key,
  stat_id bigint references ${prefix}stats(id), -- a stat message
  order_id bigint references ${prefix}orders(id), -- a job message
  agent_id bigint references ${prefix}agents(id), -- an agent message
  handle varchar,
  status integer not null default 0, -- 0 - new, 1 - acknowledged, 2 - deferred, 3 - resolved
  category integer,
  message varchar not null,
  extra json,
  audit json not null default '[]',
  deferred_until timestamptz,
  created_at timestamptz not null default CURRENT_TIMESTAMP(3),
  updated_at timestamptz not null default CURRENT_TIMESTAMP(3)
);`;

  yield trans.nonQuery(script);
};

this.down = function*(trans) {
  var prefix = config.prefix || '';
  var script = `
drop table ${prefix}messages;
drop table ${prefix}output;
drop table ${prefix}stat_entries;
drop table ${prefix}stats;
drop table ${prefix}stat_definitions;
drop table ${prefix}agents;
drop table ${prefix}resources;
drop table ${prefix}orders;
drop table ${prefix}schedules;
drop table ${prefix}entries;
drop table ${prefix}jobs;`;

  yield trans.nonQuery(script);
};
