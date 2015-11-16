'use strict';

var pg = require('postgres-gen');
var pgdao = require('postgres-gen-dao');
var migrate = require('postgres-gen-migrate');
var path = require('path');
var config = require('flapjacks').read({ name: 'batchalyzer-data-pg' });
var log;

var agentRE = /\$AGENT/g;

var configPrefix = 'batchalyzer.data';

module.exports = function(cfg) {
  if (cfg) config.merge(configPrefix, cfg);

  if (!cfg.log) log = require('blue-ox')('batch:data');
  else log = cfg.log;

  // run any migrations
  config.set(`${configPrefix}.path`, path.join(__dirname, 'migrations'));
  config.ensure(`${configPrefix}.prefix`, 'scheduler_');
  let prefix = config.get(`${configPrefix}.prefix`);

  return migrate(config.get(configPrefix))().then(() => {
    let db = pg(config.get(`${configPrefix}.connection`), config.get(`${configPrefix}.options`, {}));
    db.log(msg => log[msg.error ? 'error' : 'trace'](`${msg.query}\n${JSON.stringify(msg.params)}${msg.error ? '\n' + msg.error : ''}`));

    // create DAO objects
    let bits = [
      pgdao({ db, table: `${prefix}jobs` }).ready,
      pgdao({ db, table: `${prefix}schedules` }).ready,
      pgdao({ db, table: `${prefix}entries` }).ready,
      pgdao({ db, table: `${prefix}orders` }).ready,
      pgdao({ db, table: `${prefix}resources` }).ready,
      pgdao({ db, table: `${prefix}agents` }).ready,
      pgdao({ db, table: `${prefix}stat_definitions` }).ready,
      pgdao({ db, table: `${prefix}stats` }).ready,
      pgdao({ db, table: `${prefix}stat_entries` }).ready,
      pgdao({ db, table: `${prefix}output` }).ready,
      pgdao({ db, table: `${prefix}messages` }).ready,
      pgdao({ db, table: `${prefix}commands` }).ready
    ];

    return Promise.all(bits).then(b => {
      let dao = { jobs: b[0], schedules: b[1], entries: b[2], orders: b[3], resources: b[4], agents: b[5], statDefinitions: b[6], stats: b[7], statEntries: b[8], output: b[9], messages: b[10], commands: b[11] };

      let lockResources = (function() {
        let resourceQ = [];

        function pump() {
          let next = resourceQ.shift();

          if (next) {
            Promise.resolve(true).then(() => {
              return next.cb();
            }).then(
              v => next.ok(v),
              err => next.fail(err)
            ).then(() => {
              if (resourceQ.length > 0) pump();
            });
          }
        }

        function lockResources(cb) {
          let ok, fail, res = new Promise((yes, no) => {
            ok = yes; fail = no;
          }), go = resourceQ.length === 0;

          resourceQ.push({ ok, fail, cb });

          if (go) pump();

          return res;
        }

        return lockResources;
      })();

      // return service object with methods to access data
      let out = {
        // Job related methods
        // -------------------
        // list all entries
        entries(options = {}) {
          if (options.date) {
            return dao.entries.query(
              `with lasts as (select o.entry_id, max(o.completed_at) as done from orders o where o.schedule_id = (select id from schedules where target = ?) group by entry_id)
              select @e.*, @job.*, l.done, l.*
              from @${prefix}entries e
                left join lasts l on l.entry_id = e.id
                left join @${prefix}jobs job on e.job_id = job.id`,
              options.date,
              { fetch: { job: '' }, extra: { e(rec, res) {
                res.lastScheduleRun = rec.done;
              } } }
            );
          } else {
            return dao.entries.query(`select e.*, @job.* from ${prefix}entries e left join @${prefix}jobs job on e.job_id = job.id`, { fetch: { job: '' } });
          }
        },
        jobs() {
          return dao.jobs.find();
        },
        orders(opts = {}) {
          let q = [''], join = '';
          if ('schedule' in opts) {
            q[0] += `${join}schedule_id = ?`;
            q.push(opts.schedule);
            join = ' AND ';
          }

          if ('entry' in opts) {
            q[0] += `${join}entry_id = ?`;
            q.push(opts.entry);
            join = ' AND ';
          }

          if (!q[0]) return Promise.reject(new Error(`You don't really want all of the orders.`));

          return dao.orders.find(q);
        },
        getOutput(opts = {}) {
          let q = [''];

          if ('entry' in opts && 'schedule' in opts) {
            q[0] += 'order_id in (select id from orders where entry_id = ? and schedule_id = ? order by created_at desc limit 1) order by updated_at desc limit 1';
            q.push(opts.entry, opts.schedule);
          } else if ('order' in opts) {
            q[0] += 'order_id = ?';
            q.push(opts.order);
          }

          if (!q[0]) return Promise.reject(new Error(`Not enough conditions to find specific output.`));

          return dao.output.findOne(q);
        },
        findEntry(id) {
          return dao.entries.query(`select e.*, @job.* from ${prefix}entries e left join @${prefix}jobs job on e.job_id = job.id where e.id = ?`, id, { fetch: { job: '' } }).then(es => es[0]);
        },
        findCustomEntry(id) {
          return dao.entries.query(`select e.*, @job.* from ${prefix}entries e left join @${prefix}jobs job on e.job_id = job.id where e.custom_id = ?`, id, { fetch: { job: '' } }).then(es => es[0]);
        },
        putJob(job) {
          return dao.jobs.upsert(job);
        },
        putEntry(entry) {
          return dao.entries.upsert(entry);
        },
        dropEntry(entry) {
          return dao.entries.del(entry);
        },
        putOrder(order) {
          return dao.orders.upsert(order);
        },
        findOrder(id) {
          return dao.orders.query(`select o.*, @entry.*, @job.* from ${prefix}orders o join @${prefix}entries entry on o.entry_id = entry.id left join @${prefix}jobs job on entry.job_id = job.id where o.id = ?`, id, { fetch: { entry: { job: '' } } }).then(rows => {
            if (rows.length !== 1) throw new Error('Wrong number of results');
            else return rows[0];
          });
        },
        orderStep(order, step) {
          return db.transaction(function*(t) {
            const o = yield dao.orders.findOne('id = ?', order.id);
            o.steps.push(step);
            yield dao.orders.update(o);
            order.steps = o.steps;
            order.updatedAt = o.updatedAt;
            return order;
          });
        },
        lastEntryOrder(entry, opts = {}) {
          if (opts.success) {
            return dao.orders.findOne('entry_id = ? and completed_at is not null and status = 0 order by completed_at desc limit 1', entry.id);
          } else if (opts.fail) {
            return dao.orders.findOne('entry_id = ? and completed_at is not null and status = 1 order by completed_at desc limit 1', entry.id);
          } else if (opts.other) {
            return dao.orders.findOne('entry_id = ? and completed_at is not null and status <> 0 and status <> 1 order by completed_at desc limit 1', entry.id);
          } else {
            return dao.orders.findOne('entry_id = ? and completed_at is not null order by completed_at desc limit 1', entry.id);
          }
        },
        lastEntryOrders(entry, opts = {}) {
          const limit = (typeof opts.limit === 'number' && opts.limit <= 40 && opts.limit > 0) ? opts.limit : 10;
          return dao.orders.find(`entry_id = ? and completed_at is not null order by completed_at desc limit ${limit}`, entry.id ? entry.id : entry);
        },
        // get list of all active orders by schedule
        activeSchedules(opts = {}) {
          if (!('allOrders' in opts) || opts.allOrders) {
            return dao.schedules.query(
              `with sched as (select @s.* from @${prefix}schedules s where s.${opts.id ? 'id = ' + opts.id : 'active = true'}),
              stuff as (select @jobs.*, @entry.*, @job.* from @${prefix}orders jobs join @${prefix}entries entry on jobs.entry_id = entry.id left join @${prefix}jobs job on entry.job_id = job.id where jobs.schedule_id in (select @:s.id from sched))
              select sched.*, stuff.* from sched left join stuff on stuff.@:jobs.schedule_id = @:s.id where @:s.active = true`,
              { fetch: { jobs: [{ entry: { job: '' } }] } }
            );
          } else {
            return dao.schedules.query(
              `with sched as (select @s.* from @${prefix}schedules s where s.${opts.id ? 'id = ' + opts.id : 'active = true'}),
              bits as (select @jobs.*, @entry.*, @job.* from @${prefix}orders jobs join @${prefix}entries entry on jobs.entry_id = entry.id left join @${prefix}jobs job on entry.job_id = job.id where jobs.schedule_id in (select @:s.id from sched) order by jobs.created_at desc),
              lasts as (select ROW_NUMBER() over(partition by @:jobs.schedule_id, @:jobs.entry_id order by @:jobs.created_at desc) as rownum, bits.* from bits),
              stuff as (select * from lasts where rownum = 1)
              select sched.*, stuff.* from sched left join stuff on stuff.@:jobs.schedule_id = @:s.id where @:s.active = true`,
              { fetch: { jobs: [{ entry: { job: '' } }] } }
            );
          }
        },
        liveSchedules() {
          return dao.schedules.query(
            `with sched as (select @s.* from @${prefix}schedules s where (select count(id) from orders where status < 0 and schedule_id = s.id) > 0),
            bits as (select @jobs.*, @entry.*, @job.* from @${prefix}orders jobs join @${prefix}entries entry on jobs.entry_id = entry.id left join @${prefix}jobs job on entry.job_id = job.id where jobs.schedule_id in (select @:s.id from sched) order by jobs.created_at desc),
            lasts as (select ROW_NUMBER() over(partition by @:jobs.schedule_id, @:jobs.entry_id order by @:jobs.created_at desc) as rownum, bits.* from bits),
            stuff as (select * from lasts where rownum = 1)
            select sched.*, stuff.* from sched left join stuff on stuff.@:jobs.schedule_id = @:s.id`,
            { fetch: { jobs: [{ entry: { job: '' } }] } }
          );
        },
        findSchedule(date) {
          return dao.schedules.find('target = ?', date);
        },
        // create schedule and order all jobs
        newSchedule(schedule, orders = []) {
          schedule.active = true;
          return db.transaction(function*(t) {
            let s = yield dao.schedules.insert(schedule, { t });
            if ( !orders || !orders.length ) return s;

            for (let i = 0; i < orders.length; i++) {
              let o = orders[i];
              o.scheduleId = s.id;
              yield dao.orders.insert(o, { t });
            }
            return dao.schedules.query(
              `with sched as (select @s.* from @${prefix}schedules s where s.active = true),
              stuff as (select @jobs.*, @entry.*, @job.* from @${prefix}orders jobs join @${prefix}entries entry on jobs.entry_id = entry.id left join @${prefix}jobs job on entry.job_id = job.id where jobs.schedule_id in (select @:s.id from sched))
              select sched.*, stuff.* from sched left join stuff on stuff.@:jobs.schedule_id = @:s.id where @:s.id = ?`,
              s.id,
              { fetch: { jobs: [{ entry: { job: '' } }] } }
            ).then(ss => ss[0]);
          });
        },
        deactivateSchedules(ds, as = []) {
          if (ds && !Array.isArray(ds)) ds = [ds];
          if (as && !Array.isArray(as)) as = [as];
          return db.transaction(function*(t) {
            if (as && as.length > 0) yield db.nonQuery(`update ${prefix}schedules set active = true where id in ?`, [as.map(s => s.id)]);
            return yield db.nonQuery(`update ${prefix}schedules set active = false where id in ?`, [ds.map(s => s.id)]);
          });
        },
        resources() {
          return dao.resources.find();
        },
        putResource(res) {
          return dao.resources.upsert(res);
        },
        // refresh resources - used once at startup
        refreshResources() {
          return db.transaction(function*(t) {
            // reset resource usage
            yield t.nonQuery(`update ${prefix}resources set used = 0`);

            // find currently running job configs
            let os = (yield t.query(`select e.config entry, j.config job, a.name from orders o join agents a on o.agent_id = a.id join entries e on o.entry_id = e.id left join jobs j on e.job_id = j.id where agent_id is not null and completed_at is null and o.status = 10`, { t })).rows;

            let map = {};
            for (let i = 0; i < os.length; i++) {
              let o = os[i];

              if (o.entry && o.entry.resources) {
                for (let k in o.entry.resources) {
                  let kk = k.replace(agentRE, o.name);
                  if (!(kk in map)) map[kk] = 0;
                  map[kk] += o.entry.resources[k];
                }
              }

              if (o.job && o.job.resources) {
                for (let k in o.job.resources) {
                  let kk = k.replace(agentRE, o.name);
                  if (!(kk in map)) map[kk] = 0;
                  map[kk] += o.job.resources[k];
                }
              }
            }

            let res = yield dao.resources.find({ t });
            for (let k in map) {
              for (let i = 0; i < res.length; i++) {
                if (res[i].name === k) {
                  if (res[i].type === 0) {
                    res[i].used += map[k];
                  }
                  break;
                }
              }
            }

            for (let i = 0; i < res.length; i++) {
              if (res[i].used > 0) yield t.nonQuery('update resources set used = ? where id = ?', res[i].used, res[i].id);
            }

            // retun list of resources
            return yield dao.resources.find({ t });
          });
        },
        acquireResources(rs, map) {
          return lockResources(() => {
            return db.transaction(function*(t) {
              let out = {};
              for (let name in rs) {
                let count = rs[name];
                let r = yield dao.resources.findOne('name = ?', name, { t });
                if (!r) throw new Error(`Resource not found: ${name}`);

                if (r.type === 0) {
                  if (r.used < r.total && (r.total - r.used - count) >= 0) {
                    r.used += count;
                    yield dao.resources.update(r, { t });
                    out[name] = r;
                  } else throw new Error(`Resource not available: ${name}`);
                } else if (r.type === 1) {
                  let now = Math.floor(new Date().getTime() / 1000), min = now - 60;

                  for (let i = r.rate.length - 1; r >= 0; i++) {
                    if (r.rate[i] < min) r.splice(i, 1);
                  }

                  if (r.rate.length < r.maxPerMinute) {
                    r.rate.push(now);
                  } else throw new Error(`Resource limit reached: ${name}`);

                  yield dao.resources.save(r, { t } );
                  out[name] = r;
                } else {
                  throw new Error('Unknown resource type');
                }
              }

              // acquisition was successful, so update given map if provided
              if (map) {
                for (let k in out) map[k] = out[k];
              }

              return true;
            });
          });
        },
        releaseResources(rs, map) {
          return lockResources(() => {
            return db.transaction(function*(t) {
              let out = {};

              for (let name in rs) {
                let count = rs[name];
                let r = yield dao.resources.findOne('name = ?', name);
                if (r.type === 0) {
                  r.used -= count;
                  if (r.used < 0) r.used = 0;
                  out[name] = r;
                  yield dao.resources.update(r);
                }
              }

              if (map) {
                for (let k in rs) map[k] = out[k];
              }

              return true;
            });
          });
        },
        // update the eligible timestamp
        jobReady(order, target = new Date()) {
          return db.nonQuery(`update ${prefix}orders set eligible_at = ? where id = ?`, target, order.id);
        },
        // update the start timestamp
        jobStart(order, agent) {
          return db.nonQuery(`update ${prefix}orders set started_at = ?, agent_id = ?, status = 10 where id = ?`, new Date(), agent.id, order.id);
        },
        // append job output
        jobOutput(order, type, output) {
          return db.transaction(function*(t) {
            yield t.nonQuery(`lock ${prefix}output in exclusive mode`);
            let count = yield t.nonQuery(`update ${prefix}output set ${type === 'error' ? 'syserr = syserr' : 'sysout = sysout'} || ? where order_id = ?;`, output, order.id);
            if (count > 1) throw new Error('Tried to update sysout for too many orders.');
            else if (count < 1) {
              yield t.nonQuery(`insert into ${prefix}output (sysout, syserr, order_id) values (?, ?, ?)`, type === 'error' ? '' : output, type === 'error' ? output : '', order.id);
            }
            return true;
          });
        },
        // job complete
        jobComplete(order, status) {
          return db.transaction(function*(t) {
            let count = yield t.nonQuery(`update ${prefix}orders set status = ?, result = ?, completed_at = now() where id = ?;`, status, order.result, order.id);
            if (count > 1) throw new Error('Tried to update status for too many orders.');
            yield t.nonQuery(`update ${prefix}entries set last_run = now() where id = ?`, order.entryId);
            return true;
          });
        },
        // order (or reorder) the given job in the given schedule
        orderJob(entry, schedule) {
          return db.transaction(function*(t) {
            // create new record
            let o = { entryId: entry.id, scheduleId: schedule.id, status: -1 };
            o = yield dao.orders.insert(o);
            // return the record
            return o;
          });
        },

        // Agent related methods
        // ---------------------
        // get list of agents
        agents(opts = {}) {
          if (opts.missing) {
            return dao.agents.find(`status = 1 and last_seen < now() - ?::interval`, `${opts.minutes || 5} minutes`);
          } else {
            return dao.agents.find();
          }
        },
        putAgent(agent) {
          return dao.agents.upsert(agent);
        },
        // reset agent status to disconnected and return list
        resetAgents() {
          return db.transaction(function*(t) {
            yield t.nonQuery(`update ${prefix}agents set status = 0`);
            return yield dao.agents.find();
          });
        },
        // new agent info
        agentInfo(agent, info, ip) {
          return db.nonQuery(`update ${prefix}agents set location = ?, info = ? where id = ?`, ip, info, agent.id);
        },
        // update an agent
        agentStatus(agent, status) {
          return db.nonQuery(`update ${prefix}agents set status = ?, last_seen = ? where id = ?`, status, new Date(), agent.id);
        },

        // Stat related methods
        // --------------------
        // get list of stats
        stats() {
          return dao.stats.query(
            `select @s.*, @definition.* from @${prefix}stats s join @${prefix}stat_definitions definition on s.definition_id = definition.id`,
            { fetch: { definition: {} } }
          );
        },
        // get list of definitions
        statDefinitions() {
          return dao.statDefinitions.find();
        },
        findStat(id) {
          return dao.stats.findOne('id = ?', id);
        },
        // new stat value posted
        statEntry(stat, value, status, state) {
          return db.transaction(function*() {
            yield db.nonQuery(`insert into ${prefix}stat_entries (stat_id, value, status) values (?, ?, ?);`, stat.id, value, status);
            yield db.nonQuery(`update ${prefix}stats set state = ? where id = ?`, state, stat.id);
            return true;
          });
        },
        currentStats() {
          return []
          return dao.stats.query(
            // fetch stats with last 10 values, avgs over last 7 days, current value, warning, crit, name, and agent name
            ``
          );

        },

        // Message related methods
        // -----------------------
        // get active messages
        messages(opts = {}) {
          if (opts.all) {
            return dao.messages.find('status = 3 order by updated_at desc limit ?', opts.limit || 100);
          } else {
            return dao.messages.find('status < 3');
          }
        },
        // post/update message
        message(opts = {}) {
          return db.transaction(function*(t) {
            let msg, audit = {}, count = 0;

            if (opts.id) msg = (yield dao.messages.find('id = ?', opts.id))[0];
            else if (opts.handle) msg = (yield dao.messages.find('status < 3 and handle = ?', opts.handle))[0];

            // don't audit the message if it's the same
            if (msg && opts.message === msg.message) delete opts.message;

            // if the message is being resolved, but none is found, do nothing
            if (!msg && opts.status >= 3) return true;

            if (!msg && !opts.message) throw new Error('No message found and no message provided to post.');

            if (!msg) msg = { message: opts.message, audit: [] };

            for (let k in opts) if (opts[k] === msg[k]) delete opts[k];

            if ('status' in opts) audit.status = msg.status = opts.status;
            if ('message' in opts) msg.message = audit.message = opts.message;
            if ('who' in opts) audit.who = opts.who;
            if ('handle' in opts) msg.handle = opts.handle;
            if ('category' in opts) msg.category = opts.category;
            if ('priority' in opts) msg.priority = opts.priority;

            if ('agentId' in opts) msg.agentId = opts.agentId;
            if ('statId' in opts) msg.statId = opts.statId;
            if ('orderId' in opts) msg.orderId = opts.orderId;
            if ('defer' in opts) audit.defer = msg.deferredUntil = opts.defer;
            if ('extra' in opts) audit.extra = msg.extra = opts.extra;

            // only audit if there is anything to post
            for (let k in audit) count++;
            if (count > 0) msg.audit.push(audit);

            return yield dao.messages.upsert(msg);
          });
        },
        // commands
        commands(opts = {}) {
          if ('id' in opts) {
            return dao.commands.findOne('id = ?', opts.id);
          } else if ('name' in opts && 'version' in opts) {
            return dao.commands.findOne('name = ? and version = ?', opts.name, opts.version);
          } else return dao.commands.find();
        },
        putCommand(cmd) {
          return dao.commands.upsert(cmd);
        },
        lastCommandVersion(name, version = 'latest') {
          return db.transaction(function*(t) {
            const cmd = (yield dao.commands.query(`select * from commands where name = ? order by version desc limit 1`, name, { t }))[0];
            if (!cmd) return { version: 0, updated: null, versionUpdated: null };

            if (version === 'latest') {
              return { version: cmd.version, updated: cmd.updatedAt, versionUpdated: cmd.updatedAt };
            } else {
              return { version: cmd.version, updated: cmd.updatedAt, versionUpdated: ((yield dao.comands.query(`select * from commands where name = ? and version = ?`), name, version, { t })[0] || {}).updatedAt || null };
            }
          });
        }
      };

      return out;
    });
  }, err => {
    console.log('Migration failed, bailing...');
    console.error(err);
    process.exit(1);
  });
};
