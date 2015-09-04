const koa = require('koa');
const config = require('flapjacks').read();
const http = require('http');
const route = require('koa-route');

const configPrefix = 'batchalyzer.api';

const log = (function() {
  let prefix = config.get('logPrefix', '');
  let l = require('blue-ox');
  let general = l(prefix, 'trace');

  if (prefix) prefix += ':';

  general.server = l(`${prefix}server`, 'trace');
  general.data = l(`${prefix}data`, 'trace');

  return general;
})();

module.exports = function(cfg) {
  const prefix = configPrefix;
  const mount = config.get(`${prefix}.mount`, '/service/scheduler/api');

  if (cfg) config.merge(prefix, cfg);

  if (!config.get(`${prefix}.data.module`)) {
    log.server.error('No data module specified');
    return Promise.reject(new Error('No data module specified.'));
  }

  // load data module and init
  let dataConfig = config.get(`${prefix}.data.config`, {});
  dataConfig.log = log.data;
  return require(config.get(`${prefix}.data.module`))(dataConfig).then(dao => {
    const app = koa();
    let server = config.get(`${configPrefix}.server`), initedServer = false;
    // if no http server provided, spin one up
    if (!server) {
      let port = config.get(`${configPrefix}.port`, 3002);
      log.server.info('Starting own HTTP server on port ' + port);
      server = http.createServer();
      server.listen(port);
      initedServer = true;

      // we are providing the server, so set up request logging
      app.use(function*(next) {
        let start = +(new Date()), error;
        try {
          yield next;
        } catch (e) {
          error = e;
        }

        log.server.info(`${this.method} ${this.path} ${error ? 'FAILED - ' + error.message : 'OK'} - ${this.status} - ${+(new Date()) - start}ms`);
      });
    }

    log.server.info(`Mounting routes at ${mount}`);

    // get active schedules with jobs
    app.use(route.get(`${mount}/schedules`, function*() {
      let schedules = yield dao.activeSchedules({ allOrders: false });

      for (let i = 0; i < schedules.length; i++) {
        const s = schedules[i];
        delete s._generated_loaded;
        for (let ii = 0; ii < s.jobs.length; ii++) {
          const j = s.jobs[ii];
          delete j._generated_loaded;
          if (j.entry) {
            delete j.entry._generated_loaded;
            if (j.entry.job) delete j.entry.job._generated_loaded;
          }
        }
      }

      this.body = schedules;
    }));

    // get agents
    app.use(route.get(`${mount}/agents`, function*() {
      let agents = yield dao.agents();

      for (let i = 0; i < agents.length; i++) {
        const a = agents[i];
        delete a._generated_loaded;
      }

      this.body = agents;
    }));

    // get resources
    app.use(route.get(`${mount}/resources`, function*() {
      let res = yield dao.resources();

      for (let i = 0; i < res.length; i++) {
        delete res[i]._generated_loaded;
      }

      this.body = res;
    }));

    // get messages
    app.use(route.get(`${mount}/messages`, function*() {
      let msgs = yield dao.messages();

      for (let i = 0; i < msgs.length; i++) {
        delete msgs[i]._generated_loaded;
      }

      this.body = msgs;
    }));

    // connect to scheduler for websocket fed updates
    // pass live updates to clients (filtered for client? probably not?)

    server.on('request', app.callback());
  });
};
