'use strict';

const emitter = (function() {
  let util = require('util');
  let EventEmitter = require('events');

  function Emitter() {
    EventEmitter.call(this);
  }

  util.inherits(Emitter, EventEmitter);

  return new Emitter();
})();

var { isEmptyObject, zeroDate, nextTime, addTime, deepAssign, rand } = require('./util');
var prefix = 'batchalyzer';
var agentRE = /\$AGENT/g;

module.exports = function(cfg, log) {
  let pumpMax = cfg.get(`${prefix}.maxScheduleWaitSeconds`, 600);

  function _fireJob(context, job, agent) {
    let { dao } = context;

    log.job.trace(`Firing ${job.id} to ${agent.name}`);
    agent.fire('job', deepAssign({ id: job.id }, job.config));

    job.status = 10;
    return dao.jobStart(job, agent).then(null, err => log.job.error(`Failed to set start time for ${job.id}`, err));
  }

  function hasConditions(schedule, order) {
    let e = order.entry;
    if (e) {
      e = e.config;
      if (e.conditions && e.conditions.in) {
        for (let i = 0; i < e.conditions.in.length; i++) {
          if (!schedule.conditions[e.conditions.in[i]]) return false;
        }
      }

      e = order.entry.job;
      if (e) {
        e = e.config;
        if (e.conditions && e.conditions.in) {
          for (let i = 0; i < e.conditions.in.length; i++) {
            if (!schedule.conditions[e.conditions.in[i]]) return false;
          }
        }
      }
    }

    return true;
  }

  function _findOrder(schedules, dao, id) {
    for (let k in schedules) {
      let orders = schedules[k].jobs || [];
      for (let i = 0; i < orders.length; i++) {
        if (orders[i] && orders[i].id == id) return Promise.resolve(orders[i]);
      }
    }
    return dao.findOrder(id).then(o => {
      let s = schedules[o.scheduleId];
      if (s) s.jobs.push(o);
      return o;
    });
  }

  function jobComplete(context, data, agent) {
    let { dao, schedules, findOrder } = context;

    return findOrder(data.id).then(job => {
      let next = Promise.resolve(true);

      job.result = data.result;
      job.status = data.result === 0 ? 0 : data.result === 1 ? 1 : data.result > 1 ? 2 : 4;

      if (data.result === 0) {
        let s = schedules[job.scheduleId], changed = false;

        if (s && job.entry && job.entry.config.conditions && job.entry.config.conditions.out) {
          for (let k in job.entry.config.conditions.out) {
            changed = true;
            s.conditions[k] = true;
          }
        }

        if (s && job.entry && job.entry.job && job.entry.job.config.conditions && job.entry.job.config.conditions.out) {
          for (let k in job.entry.job.config.conditions.out) {
            changed = true;
            s.conditions[k] = true;
          }
        }

        if (changed) next = dao.updateSchedule(s);
      }

      let msg = {
        handle: `job ${job.entryId} state`,
        message: `Job ${job.config.name || (job.entry.job || {}).name || job.id} ${job.status === 0 ? 'OK' : job.status === 1 ? 'FAILED' : job.status === 2 ? 'WARNING' : 'UNKOWN'}`
      };
      if (data.result === 0) msg.status = 3;
      dao.message(msg);

      // TODO: message manipulation

      return next.then(() => {
        let resources = {};
        if (job.config.resources) {
          for (let k in job.config.resources) {
            let kk = k.replace(agentRE, agent.name);
            if (kk in resources) resources[kk] += job.config.resources[k];
            else resources[kk] = job.config.resources[k];
          }
        }

        return Promise.all([
          dao.releaseResources(resources),
          dao.jobComplete(job, job.status)
        ]).then(() => {
          let s = schedules[job.scheduleId];

          if (s) {
            // don't try to schedule on-demand jobs again
            if (job.onDemand) return true;

            // make sure this job doesn't already have an order pending
            for (let i = 0; i < s.jobs.length; i++) {
              if (s.jobs[i].entryId === job.entryId && s.jobs[i].status < 0) {
                return true;
              }
            }

            let next = nextTime(s.target, job, isEmptyObject(job.entry.schedule) ? (job.entry.job || {}).schedule : job.entry.schedule);
            if (next) {
              return dao.orderJob(job.entry, s).then(o => {
                o.entry = job.entry;
                o.next = next;
                if ('intervalIndex' in job) o.intervalIndex = job.intervalIndex;
                s.jobs.push(o);
                o.config = deepAssign({}, (job.entry || {}).config, ((job.entry || {}).job || {}).config);
              });
            }
          }
        }, err => log.job.error(`Failure during job complete`, err)).then(() => pump(context));
      });
    });
  }

  // throttled schedule pump - defaults to running no more than once per 10 seconds
  var pump = (function() {
    let timeout, again = false, nextCycle, halted = false;

    function pump(context) {
      let { schedules, dao } = context, queue = [], next, now = new Date();

      if (nextCycle) clearTimeout(nextCycle);

      // check eligible stats
      for (let i = 0; i < context.stats.length; i++) {
        let s = context.stats[i];

        if (!s.next) { console.log('no next?', s); } // get next time?
        if (s.next) {
          if (s.next <= now) { // stat is time eligible
            context.fireStat(s);
            // TODO: track stats that never come back
            // schedule next collection too, in case the stat never comes back
            s.next = nextTime(now, s, isEmptyObject(s.config.schedule) ? s.definition.config.schedule : s.config.schedule);
            if (!next || s.next < next) next = s.next;
          } else {
            // find the next closest time to pump
            if (!next || s.next < next) next = s.next;
          }
        }
      }

      for (let k in schedules) {
        let s = schedules[k], drop = [];
        if (!s.jobs) s.jobs = [];

        for (let i = 0; i < s.jobs.length; i++) {
          let j = s.jobs[i];
          if (j.status >= 0 || j.held) continue; // skip non-pending orders

          if (!j.next) {
            j.next = nextTime(zeroDate(), j, isEmptyObject(j.entry.schedule) ? (j.entry.job || {}).schedule : j.entry.schedule);
          }
          if (j.next) {
            if (j.next <= now) { //job is time eligible
              if (!j.eligibleAt) dao.jobReady(j).then(null, err => log.job.error(`Failed to set eligible time for ${j.id}`, err));
              if (hasConditions(s, j)) {
                queue.push(j);
              }
            } else {
              // find the next closest time to pump
              if (!next || j.next < next) next = j.next;
            }
          } else {
            // remove, cause it won't be eligible? why would this happen?
            drop.remove(i);
          }
        }

        while (drop.length) s.jobs.splice(drop.pop(), 1);
      }

      // sort queue by priority, start time
      queue.sort(function(l, r) {
        if (l.priority < r.priority) return -1;
        else if (l.priorty > r.priority) return 1;
        else {
          if (l.next < r.next) return -1;
          else if (l.next > r.next) return 1;
          else return 0;
        }
      });

      return acquireResources(context, queue).then(() => {
        // schedule next pump - default to 10 minutes out if there is nothing to bump
        if (!next) next = addTime(now, pumpMax);
        log.schedule.trace(`Scheduling next cycle for ${Math.floor((next - now) / 1000)}s`);
        nextCycle = setTimeout(() => last(context), next - now);
      }, err => {
        log.schedule.error(`Failed while acquiring resources`, err);
        // schedule next pump - default to 10 minutes out if there is nothing to bump
        if (!next) next = addTime(now, pumpMax);
        log.schedule.trace(`Scheduling next cycle for ${Math.floor((next - now) / 1000)}s`);
        nextCycle = setTimeout(() => last(context), next - now);
      });
    }

    function middle(context) {
      timeout = false;
      if (again) {
        again = false;
        last(context);
      }
    }

    function last(context) {
      if (halted) {
        let schedules = context.schedules;
        for (let k in schedules) {
          let jobs = schedules[k].jobs || [];
          for (let i = 0; i < jobs.length; i++) {
            // if there are jobs still running, wait for them to finish
            if (jobs[i].status === 10) return;
          }
        }
        emitter.emit('halted');
      } else {
        if (timeout) again = true;
        else {
          timeout = true;
          pump(context).then(() => {
            timeout = setTimeout(middle, 10000, context);
          });
        }
      }
    }

    last.halt = function(context) {
      halted = true;
      emitter.emit('halting');
      let schedules = context.schedules;
      for (let k in schedules) {
        let jobs = schedules[k].jobs || [];
        for (let i = 0; i < jobs.length; i++) {
          if (jobs[i].status === 10) return;
        }
      }
      emitter.emit('halted');
    };
    last.isHalted = function() { return halted; };
    last.on = emitter.on.bind(emitter);
    last.once = emitter.once.bind(emitter);
    last.off = function(ev, listener) {
      if (listener) {
        emitter.removeListener(ev, listener);
      } else {
        emitter.removeAllListeners(ev);
      }
    };

    return last;
  })();

  function acquireResources(context, queue) {
    let { agents, resources, dao } = context;

    function next() {
      let j = queue.shift();

      if (j && !j.held) {
        let as = matchingAgents(agents, j);
        if (as.length < 1) {
          // TODO: message and unschedule?
          log.job.trace(`No agent found for ${j.id}`, agents, j.config);
          return next();
        }

        // no resources to acquire
        if (isEmptyObject(j.config.resources)) {
          return _fireJob(context, j, as[rand(as.length - 1)]).then(next, next);
        }

        if (!hasLocalResources(j)) {
          // TODO: check to see if resource acquisution is even a possibility
          let a = as[rand(as.length - 1)];
          // return random acquisition
          return dao.acquireResources(j.config.resources || {}, resources).then(() => {
            return _fireJob(context, j, a).then(next, next);
          }, err => {
            log.job.info(`Failed to acquire resources for ${j.id}`);
            return next();
          });
        } else {
          // TODO: shuffle agents?
          let step = function step() {
            let a = as.shift();
            if (a) {
              let l = j.config.resources || {}, res = {};
              for (let k in l) {
                let kk = k.replace(agentRE, a.name);
                if (kk in res) res[kk] += l[k];
                else res[kk] = l[k];
              }
              return dao.acquireResources(res, resources).then(() => {
                return _fireJob(context, j, a).then(next, next);
              }, err => {
                log.job.info(`Failed to acquire resources for ${j.id} on ${a.name}`);
                return step();
              });
            } else return next(); // couldn't find a suitable agent and acquire resources
            // TODO: send message?
          };
          return step();
        }
      } else return Promise.resolve(true);
    }

    return next();
  }

  function matchingAgents(agents, job) {
    let as = [], cfg = job.config || {};
    for (let i = 0; i < agents.length; i++) {
      let a = agents[i];
      if (!a.socket || a.halting) continue;

      if (cfg.agent && cfg.agent === a.name) as.push(a);
      else if (cfg.group && a.groups.indexOf(cfg.group) !== -1) as.push(a);
      else if (cfg.agents && Array.isArray(cfg.agents) && cfg.agents.indexOf(a.name) !== -1) as.push(a);
      else if (cfg.groups && Array.isArray(cfg.groups)) {
        for (let j = 0; j < cfg.groups.length; j++) {
          if (a.groups.indexOf(cfg.groups[j]) !== -1) {
            as.push(a);
            break;
          }
        }
      } else as.push(a); // if the job doesn't care, neither do we
    }
    return as;
  }

  function hasLocalResources(job) {
    let res = job.config.resources || {};
    for (let k in res) {
      if (k.indexOf('$AGENT') !== -1) return true;
    }
    return false;
  }

  return {
    _findOrder, _fireJob, jobComplete, hasConditions, pump
  };
};
