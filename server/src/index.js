'use strict';

const config = require('flapjacks').read({ name: 'batchalyzer' });
const log = (function() {
  let prefix = config.get('logPrefix', '');
  let l = require('blue-ox');
  let general = l(prefix, 'trace');

  if (prefix) prefix += ':';

  general.server = l(`${prefix}server`, 'trace');
  general.stat = l(`${prefix}stat`, 'trace');
  general.job = l(`${prefix}job`, 'trace');
  general.schedule = l(`${prefix}schedule`, 'trace');
  general.data = l(`${prefix}data`, 'info');

  return general;
})();
const http = require('http');
const ws = require('ws');
const koa = require('koa');
const route = require('koa-route');

const prefix = `batchalyzer`;

const { lpad, assign, deepAssign, inRange, nextInRange, nextTime, addTime, zeroDate } = require('./util');
const { _findOrder, _fireJob, jobComplete, hasConditions, pump } = require('./job')(config, log);
const { initStats, _findStat, _fireStat, statComplete } = require('./stat')(config, log);
const { initAgent, newAgentInfo } = require('./agent')(config, log);

function noop() {}
function logError(err) { log.error(err); }

// TODO: second client type that can request state and get updates -- auth via config
// TODO: API server is separate & uses second client type

// TODO: keep track of the next scheduled pump for preemption purposes

// TODO: webhooks for both input and various events

// TODO: signal to reload config file and apply changes

// TODO: refresh API that only pulls jobs with setups updated since last check?

module.exports = function(cfg) {
  if (cfg) config.merge(prefix, cfg);

  if (!config.get(`${prefix}.data.module`)) {
    return Promise.reject(new Error('No data module specified.'));
  }

  // load data module and init
  let dataConfig = config.get(`${prefix}.data.config`, {});
  dataConfig.log = log.data;
  return require(config.get(`${prefix}.data.module`))(dataConfig).then(dao => {
    // data is initialized
    // TODO: add a reload helper for loading config, etc changes
    let clients = [], apis = [], webServer, socketServer, initedServer = false, clientCount = 0;
    const port = config.get(`${prefix}.port`, 8080);
    const mount = config.get(`${prefix}.mount`, '/service/scheduler');

    let context = { dao, schedules: {}, agents: [], stats: [], findOrder, findStat, fireJob, fireStat, reload };
    context.missingAfter = config.get(`${prefix}.agentMissingMinutes`, 5);
    context.keepDone = config.get(`${prefix}.daysToKeepFinishedSchedules`, 3);

    context.auth = config.get(`${prefix}.service.authenticate`);
    if (typeof context.auth !== 'function') {
      if (Array.isArray(context.auth)) {
        const arr = context.auth;
        context.auth = function(req) {
          const user = req.headers.user, password = req.headers.password, key = req.headers['api-key'];
          for (let i = 0; i < arr.length; i++) {
            if ((arr[i].user === user && arr[i].password === password) || arr[i].key === key) return true;
          }
          return false;
        };
      } else context.auth = () => true;
    }
    if (typeof context.auth === 'function') {
      const fn = context.auth;
      context.auth = function(req) {
        const res = fn(req);
        if (res && typeof res.then !== 'function') return Promise.resolve(res);
        else return res;
      };
    }

    function findOrder(id) { return _findOrder(context.schedules, dao, id); }
    function findStat(id) { return _findStat(context.stats, dao, id); }
    function fireStat(stat) { return _fireStat(context, stat); }
    function fireJob(job) { return _fireJob(context, job); }

    function reload() {
      return Promise.all([
        initStats(context),

        // set up agents
        dao.resetAgents().then(as => {
          let cur = context.agents;
          function findAgent(a) { for (let i = 0; i < cur.length; i++) if (cur[i].id === a.id) return cur[i]; }
          as.forEach(a => {
            let o = findAgent(a);
            if (o) {
              a.socket = o.socket;
              if (o.socket) {
                a.socket.agent = a;
                a.fire = o.socket.fire;
              }
            }
          });
          context.agents = as;
        }),

        // set up resources
        dao.refreshResources().then(rs => {
          let res = {};
          for (let i = 0; i < rs.length; i++) {
            res[rs[i].name] = rs[i];
          }
          context.resources = res;
          context.resourceLst = rs;
        })
      ]).then(() => setup(context));
    }

    return reload().then(() => {
      // set up socket and (optionally) http server
      if (config.get(`${prefix}.server`)) webServer = config.get(`${prefix}.server`);
      else {
        log.server.info('Starting own HTTP server on port ' + port);
        webServer = http.createServer();
        webServer.listen(port);
        initedServer = true;
      }

      socketServer = new ws.Server({ server: webServer, path: '/scheduler', verifyClient(info, cb) {
        let [ key, name ] = [ info.req.headers.key, info.req.headers.agent ];
        let agent;
        for (let i = 0; i < context.agents.length; i++) {
          if (context.agents[i].name === name && context.agents[i].key === key) {
            agent = context.agents[i];
            break;
          }
        }
        if (!agent) cb(false, 401, 'Agent Not Found');
        else if (agent.socket) cb(false, 503, 'Agent Already Connected');
        else {
          agent.socket = true;
          info.req.agent = agent;
          cb(true);
        }
      } });

      const app = koa();
      app.use(function*(next) {
        if (this.path.indexOf(mount) !== 0) this.throw(404);
        if (!(yield context.auth(this.req))) this.throw(401);

        return yield next;
      });
      app.use(route.get(`${mount}/reload`, function*() {
        log.server.info(`Reloading...`);
        yield reload();
        pump(context);
        this.type = 'json';
        this.body = 'ok';
      }));
      webServer.on('request', app.callback());

      socketServer.on('connection', c => {
        c.id = clientCount++;
        log.server.info('Got a new client, ' + c.id);

        // register client
        c.agent = c.upgradeReq.agent;
        c.agent.socket = c;
        clients.push(c);
        c.on('close', () => {
          clients.splice(clients.indexOf(c), 1);
          log.server.info('Lost a client, ' + c.id);
          dao.agentStatus(c.agent, 0);
          dao.message({
            handle: `agent ${c.agent.id} missing`,
            message: `Agent ${c.agent.name} is disconnected`,
            agentId: c.agent.id
          });
          c.agent.socket = undefined;
          c.agent = undefined;
        });

        // set up messaging helper
        function fire(action, data) {
          let obj = { action };
          if (data) obj.data = data;
          c.send(JSON.stringify(obj));
        }

        c.agent.fire = fire;
        c.fire = fire;

        initAgent(context, c.agent).then(() => {
          c.on('message', (data, flags) => {
            let m;

            try {
              data = JSON.parse(data);
            } catch (e) {
              log.server.error(`Failed parsing message from ${c.id}.`);
              return;
            }

            switch (data.action) {
              case 'heartbeat':
                log.server.trace(`Got a heartbeat from ${c.id}`);
                dao.agentStatus(c.agent, 1).then(noop, logError);
                c.agent.lastSeen = new Date();
                dao.message({ handle: `agent ${c.agent.id} missing`, status: 3 });
                break;

              case 'info':
                log.server.trace(`Got an info packet from ${c.id}`, data.data);
                newAgentInfo(context, c.agent, data.data);

                // there may be jobs waiting on this agent to attach
                pump(context);
                break;

              case 'halting':
                log.server.info(`Got a halt notification from ${c.id} - ${c.agent.name}`);
                c.agent.halting = true;
                break;

              case 'stat':
                log.server.trace(`Got a stat packet from ${c.id}: ${data.data.value}`, data.data);
                statComplete(context, data.data);
                break;

              case 'output':
                log.server.trace(`Got an ${data.data.type} output packet ${data.data.output.length} long from ${c.id}`);
                findOrder(data.data.id).then(order => dao.jobOutput(order, data.data.type, data.data.output)).then(null, err => log.job.error(`Failed to save output chunk from ${data.data.id}`, err));
                break;

              case 'done':
                log.server.trace(`Got a job done packet from ${c.id}`, data.data);
                jobComplete(context, data.data, c.agent);
                break;

              case 'fetchCommand':
                const cmd = data.data;
                log.server.trace(`Got a command fetch request packet from ${c.id} for ${cmd.name}/${cmd.version}.`);
                dao.commands(cmd).then(cmd => c.fire('command', cmd));
                break;

              case 'fetchPrevious':
                m = data.data;
                log.server.trace(`Got a previous request from ${c.id} for ${m.entryId}`);
                findOrder(m.id).then(o => {
                  dao.lastEntryOrder({ id: o.entryId }, m).then(o => {
                    log.server.trace(`Returning found last entry to ${c.id} for ${m.id}`);
                    c.fire('previous', { request: m, previous: o });
                  }, () => {
                    log.server.trace(`Returning no last entry to ${c.od} for ${m.entryId}`);
                    c.fire('previous', { request: m });
                  });
                });
                break;

              case 'message':
                data.data.agentId = c.agent.id;
                log.server.trace(`Got a message from ${c.id}`, data.data);
                dao.message(data.data);
                break;

              case 'step':
                m = data.data;
                log.server.trace(`Got a step from ${c.id} for ${m.id}`);
                findOrder(m.id).then(o => {
                  return dao.orderStep(o, m.step);
                });
                break;

              default:
                log.server.warn(`Got an unknown message from ${c.id}`);
                break;
            }
          });
          c.on('error', err => log.server.warn(`Error from client ${c.id}`, err));
          fire('info');
        });
      });

      function missingCheck() {
        context.nextMissingCheck = false;
        missingAgents(context).then(null, err => {}).then(() => {
          context.nextMissingCheck = setTimeout(missingCheck, context.missingAfter * 60000);
        });
      }
      context.nextMissingCheck = setTimeout(missingCheck, context.missingAfter * 60000);

      pump(context);

      // return control object
      context.control = {
        close() {
          socketServer.close();
          if (initedServer) webServer.close();
          return dao.resetAgents();
          //TODO: notify agents, wait for queue drain, etc?
        }
      };

      // watch for sigint
      if (process.platform === "win32") {
        require("readline").createInterface({
          input: process.stdin,
          output: process.stdout
        }).on("SIGINT", function () {
          process.emit("SIGINT");
        });
      }

      process.on("SIGINT", function () {
        if (pump.isHalted()) {
          log.server.info('Forcibly shutting down...');
          context.control.close().then(() => process.exit(), () => process.exit());
        } else {
          log.server.info('Gracefully shutting down...');
          pump.on('halted', () => {
            log.server.info('Shutdown complete.');
            context.control.close().then(() => process.exit(), () => process.exit(1));
          });
          pump.halt(context);
        }
      });

      return context.control;
    });
  });
};


function setup(context, date) {
  if (!date) date = new Date();
  date = zeroDate(date);

  let { dao } = context, schedules = {};
  return dao.activeSchedules().then(as => {
    let cur = false;
    // TODO: pull in-mem details from old schedule if there is one?
    as.forEach(s => {
      s.targetDate = zeroDate(new Date(+s.target));
      schedules[s.id] = s;
      if (+s.targetDate === +date) cur = s;
      for (let i = 0; i < s.jobs.length; i++) {
        let j = s.jobs[i];
        j.config = deepAssign({}, (j.entry || {}).config, ((j.entry || {}).job || {}).config);
      }
    });

    if (cur === false) {
      return newDay(context).then(res => {
        schedules[res.id] = res;
      });
    } else {
      return refreshSchedule(context, cur);
    }
  }).then(() => {
    context.schedules = schedules;
    scheduleNewDay(context);
    expireSchedules(context);
  }, err => {
    log.error('Failed to set up schedule');
    log.error(err);
    process.exit(1);
  });
}

function newDay(context) {
  let { dao } = context, date = zeroDate();
  // make sure there isn't already a completed schedule
  return dao.findSchedule(date).then(ds => {
    if (ds.length > 0) return;

    // need to create new schedule
    let sched = { target: date, active: true, name: `${date.getFullYear()}-${lpad(date.getMonth() + 1, 2, '0')}-${lpad(date.getDate(), 2, '0')}` };

    return dao.entries().then(es => {
      let orders = [], map = {};
      for (let i = 0; i < es.length; i++) {
        let e = es[i];
        let next = nextTime(date, e, e.schedule || (e.job || {}).schedule);
        if (next && (!e.lastRun || e.lastRun < next)) {
          orders.push({ entryId: e.id, next, status: -1 });
          map[e.id] = e;
        }
      }

      return dao.newSchedule(sched, orders).then(s => {
        let os = s.jobs;
        for (let i = 0; i < os.length; i++) {
          let e = map[os[i].entryId];
          if (!e) continue;
          os[i].next = e.next;
          if ('intervalIndex' in e) os[i].intervalIndex = e.intervalIndex;
        }
        context.schedules[s.id] = s;
        return s;
      });
    });
  }).then(s => {
    scheduleNewDay(context);
    return s;
  });
}

// schedule the next newDay run if it isn't already scheduled
function scheduleNewDay(context) {
  if (context.nextNewDay) return;
  let next = zeroDate(new Date(+(new Date()) + 1000 + (24 * 60 * 60 * 1000))) - new Date();

  log.schedule.info(`Next new day scheduled in ${Math.floor(+next / 1000)}s`);
  context.nextNewDay = setTimeout(() => {
    context.nextNewDay = false;
    newDay(context).then(() => expireSchedules(context));
  }, next);
}

function refreshSchedule(context, s) {
  let { dao } = context, date = new Date();

  return dao.entries().then(es => {
    let orders = [];
    outer: for (let i = 0; i < es.length; i++) {
      let e = es[i];
      for (let j = 0; j < s.jobs.length; j++) {
        if (s.jobs[j].entryId === e.id && s.jobs[j].status < 0) continue outer;
      }

      let time = nextTime(date, e, e.schedule || (e.job || {}).schedule);
      if (time && (!e.lastRun || e.lastRun < time)) {
        orders.push({ entryId: e.id, next: time, status: -1, entry: e });
      }
    }

    function next() {
      let job = orders.shift();

      if (job) {
        let time = job.next;
        return dao.orderJob(job.entry, s).then(o => {
          o.entry = job.entry;
          o.next = time;
          s.jobs.push(o);
          o.config = deepAssign({}, (job.entry || {}).config, ((job.entry || {}).job || {}).config);
        }).then(next, next);
      } else return true;
    }
    return next();
  });
}

function expireSchedules(context) {
  let { dao, schedules } = context, deactivate = [], target = zeroDate(+(new Date()) - (86400000 * context.keepDone));
  sched: for (let k in schedules) {
    const s = schedules[k];
    for (let i = 0; i < s.jobs.length; i++) {
      if (s.jobs[i].next) continue sched;
    }
    deactivate.push(s);
  }

  for (let i = deactivate.length - 1; i >= 0; i--) {
    if (deactivate[i].target >= target) deactivate.splice(i, 1);
  }

  if (deactivate.length > 0) return context.dao.deactivateSchedules(deactivate);
  else return Promise.resolve(true);
}

function missingAgents(context) {
  let { dao } = context;
  return dao.agents({ missing: true, minutes: context.missingAfter }).then(as => {
    let queue = [];
    for (let i = 0; i < as.length; i++) {
      queue.push(dao.agentStatus(as[i], 2).then(() => {
        return dao.message({
          handle: `agent ${as[i].id} missing`,
          message: `Agent ${as[i].name} has a stale connection`
        });
      }));
    }
    return Promise.all(queue);
  });
}

module.exports.lpad = lpad;
module.exports.inRange = inRange;
module.exports.nextInRange = nextInRange;
module.exports.nextTime = nextTime;
module.exports.addTime = addTime;
module.exports.zeroDate = zeroDate;
