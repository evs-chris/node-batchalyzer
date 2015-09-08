const koa = require('koa');
const config = require('flapjacks').read();
const http = require('http');
const route = require('koa-route');
const sendfile = require('koa-sendfile');
const body = require('co-body');
const path = require('path');

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

        let msg = [`${this.method} ${this.path} ${error ? 'FAILED - ' + error.message : 'OK'} - ${this.status} - ${+(new Date()) - start}ms`];
        if (error) {
          msg.push(error);
          msg.push(error.stack);
        }

        log.server.info.apply(log.server, msg);
      });
    }

    log.server.info(`Mounting routes at ${mount}`);

    // get active schedules with jobs
    app.use(route.get(`${mount}/schedules`, function*() {
      this.body = stripGenerated(yield dao.activeSchedules({ allOrders: false }));
    }));

    // post condition to schedule
    app.use(route.post(`${mount}/schedule/condition`, form(function*() {
      // TODO: add conditions
      this.body = yield Promise.resolve('TODO');
    })));

    // get agents
    app.use(route.get(`${mount}/agents`, function*() {
      this.body = stripGenerated(yield dao.agents());
    }));

    // upsert agent
    app.use(route.post(`${mount}/agent`, function*() {
      this.body = stripGenerated(yield dao.putAgent(this.posted));
    }));

    // get resources
    app.use(route.get(`${mount}/resources`, function*() {
      this.body = stripGenerated(yield dao.resources());
    }));

    // upsert resource
    app.use(route.post(`${mount}/resource`, function*() {
      this.body = stripGenerated(yield dao.putResource(this.posted));
    }));

    // get messages
    app.use(route.get(`${mount}/messages`, function*() {
      this.body = stripGenerated(yield dao.messages());
    }));

    // get orders for entry
    app.use(route.get(`${mount}/schedule/:schedule/orders/:entry`, function*(schedule, entry) {
      this.body = stripGenerated(yield dao.orders({ schedule, entry }));
    }));

    // get output for order
    app.use(route.get(`${mount}/output/:order`, function*(order) {
      this.body = stripGenerated(yield dao.getOutput({ order }));
    }));

    // get last output for entry
    app.use(route.get(`${mount}/schedule/:schedule/output/:entry`, function*(schedule, entry) {
      this.body = stripGenerated(yield dao.getOutput({ schedule, entry }));
    }));

    // HTML Client
    const assetsRE = /^\/(js|img|css)\//;
    app.use(route.get(`${mount}/`, function*() {
      let f = path.join(__dirname, 'client/index.html');
      yield* sendfile.call(this, f);
    }));
    app.use(function*(next) {
      if (this.path.replace(mount, '') === '/js/config.js') {
        this.type = 'js';
        this.body = `var config = {
  mount: '${mount}'
};`;
      } else return yield next;
    });
    app.use(function*(next) {
      if (this.method !== 'GET') return yield next;

      let p = this.path.replace(mount, '');
      if (assetsRE.test(p)) {
        yield* sendfile.call(this, path.join(__dirname, 'client', p));
      }
    });

    // TODO: connect to scheduler for websocket fed updates
    // TODO: pass live updates to clients (filtered for client? probably not?)

    server.on('request', app.callback());
  });
};

function stripGenerated(what) {
  if (!what) return what;
  if (Array.isArray(what)) {
    for (let i = 0; i < what.length; i++) {
      if (typeof what[i] === 'object') stripGenerated(what[i]);
    }
  } else if (typeof what === 'object') {
    if ('_generated_loaded' in what) {
      delete what._generated_loaded;
      for (let k in what) {
        if (typeof what[k] === 'object') stripGenerated(what[k]);
      }
    }
  }
  return what;
}

function form(opts, func) {
  const fn = typeof opts === 'function' ? opts : func;
  const o = typeof opts === 'function' ? func || {} : opts;

  if (typeof fn !== 'function') throw new Error('I need a function.');
  return function*() {
    this.posted = yield body(opts, this);
    return yield fn.apply(this, Array.prototype.slice.call(arguments, 0));
  };
}
