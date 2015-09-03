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
      pgdao({ db, table: `${prefix}messages` }).ready
    ];

    return Promise.all(bits).then(b => {
      let dao = { jobs: b[0], schedules: b[1], entries: b[2], orders: b[3], resources: b[4], agents: b[5], statDefinitions: b[6], stats: b[7], statEntries: b[8], output: b[9], messages: b[10] };

      let lockResources = (function() {
        let resourceQ = [];

        function pump() {
          let next = resourceQ.shift();

          if (next) {
            Promise.resolve(true).then(() => {
              next.cb();
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
        entries() {
          return dao.entries.query(`select e.*, @job.* from ${prefix}entries e left join @${prefix}jobs job on e.job_id = job.id`, { fetch: { job: '' } });
        },
        findOrder(id) {
          return dao.orders.query(`select o.*, @entry.*, @job.* from ${prefix}orders o join @${prefix}entries entry on o.entry_id = entry.id left join @${prefix}jobs job on entry.job_id = job.id where o.id = ?`, id, { fetch: { entry: { job: '' } } }).then(rows => {
            if (rows.length !== 1) throw new Error('Wrong number of results');
            else return rows[0];
          });
        },
        // get list of all active orders by schedule
        activeSchedules() {
          return dao.schedules.query(
            `select @s.*, @jobs.*, @entry.*, @job.*
            from @${prefix}schedules s left join @${prefix}orders jobs on jobs.schedule_id = s.id join @${prefix}entries entry on jobs.entry_id = entry.id left join @${prefix}jobs job on entry.job_id = job.id
            where s.active = true`,
            { fetch: { jobs: [{ entry: { job: '' } }] } }
          );
        },
        findSchedule(date) {
          return dao.schedules.find('target >= ? and target <= ?', date, date);
        },
        // create schedule and order all jobs
        newSchedule(schedule, orders) {
          return db.transaction(function*(t) {
            let s = yield dao.schedules.insert(schedule, { t });
            for (let i = 0; i < orders.length; i++) {
              let o = orders[i];
              o.scheduleId = s.id;
              yield dao.orders.insert(o, { t });
            }
            return yield dao.schedules.query(
              `select @s.*, @jobs.*, @entry.*, @job.*
              from @${prefix}schedules s left join @${prefix}orders jobs on jobs.schedule_id = s.id join @${prefix}entries entry on jobs.entry_id = entry.id left join @${prefix}jobs job on entry.job_id = job.id
              where s.id = ?`,
              s.id,
              { fetch: { jobs: [{ entry: { job: '' } }] }, t }
            ).then(ss => ss[0]);
          });
        },
        // refresh resources - used once at startup
        refreshResources() {
          return db.transaction(function*(t) {
            // reset resource usage
            yield t.nonQuery(`update ${prefix}resources set used = 0`);

            // find currently running job configs
            let os = (yield t.query(`select e.config entry, j.config job, a.name from orders o join agents a on o.agent_id = a.id join entries e on o.entry_id = e.id left join jobs j on e.job_id = j.id where agent_id is not null and completed_at is null`, { t })).rows;

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
              for (let i = 0; i < rs.length; i++) {
                let { name, count } = rs[i];
                let r = yield dao.resources.findOne('name = ?', { t });
                if (!r) throw new Error('Resource not found');

                if (r.type === 0) {
                  if (r.used < r.total && (r.total - r.used - count) > 0) {
                    r.used += count;
                    yield dao.resources.update(r, { t });
                    out[name] = r;
                  } else return false;
                } else if (r.type === 1) {
                  let now = Math.floor(new Date().getTime() / 1000), min = now - 60;

                  for (let i = r.rate.length - 1; r >= 0; i++) {
                    if (r.rate[i] < min) r.splice(i, 1);
                  }

                  if (r.rate.length < r.maxPerMinute) {
                    r.rate.push(now);
                  }

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
        releaseResources(rs) {
          return lockResources(() => {
            return db.transaction(function*(t) {
              for (let i = 0; i < rs.length; i++) {
                let { name, count } = rs;
                let r = yield dao.resources.findOne('name = ?', name);
                if (r.type === 0) {
                  r.used -= count;
                  if (r.used < 0) r.used = 0;
                  yield dao.resources.update(r);
                }
              }

              return true;
            });
          });
        },
        // update the eligible timestamp
        jobReady(order) {
          return db.nonQuery(`update ${prefix}orders set eligible_at = ? where id = ?`, new Date(), order.id);
        },
        // update the start timestamp
        jobStart(order, agent) {
          return db.nonQuery(`update ${prefix}orders set started_at = ?, agent_id = ? where id = ?`, new Date(), agent.id, order.id);
        },
        // append job output
        jobOutput(order, type, output) {
          return db.transaction(function*(t) {
            let count = yield t.nonQuery(`update ${prefix}output set ${type === 'error' ? 'syserr = syserr' : 'sysout = sysout'} || ? where id = ?;`, output, order.id);
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
        // reset agent status to disconnected and return list
        resetAgents() {
          return db.transaction(function*(t) {
            yield t.nonQuery(`update ${prefix}agents set status = 0`);
            return yield dao.agents.find();
          });
        },
        // update an agent
        agentStatus(agent, status) {
          return db.transaction(function*(t) {
            let rec = yield dao.agents.findOne('id = ?', agent.id, { t });
            rec.status = status;
            rec.lastSeen = new Date();
            return yield dao.agents.update(rec, { t });
          });
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

        // Message related methods
        // -----------------------
        // get active messages
        messages(opts) {
          if (opts.all) {
            return dao.messages.find('true = true order by updated_at desc limit ?', opts.limit || 100);
          } else {
            return dao.messages.find('status < 3');
          }
        },
        // add a new message
        postMessage(msg) {
        },
        //update message
        changeMessage(id, who, status) {
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
