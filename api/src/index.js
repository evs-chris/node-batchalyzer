const koa = require('koa');
const config = require('flapjacks').read({ name: 'batchalyzer-api' });
const http = require('http');
const route = require('koa-route');
const sendfile = require('koa-sendfile');
const body = require('co-body');
const path = require('path');

const configPrefix = 'api';

const log = (function() {
  let prefix = config.get('logPrefix', '');
  let l = require('blue-ox');
  let general = l(prefix, 'trace');

  if (prefix) prefix += ':';

  general.server = l(`${prefix}server`, 'trace');
  general.data = l(`${prefix}data`, 'trace');

  return general;
})();

// TODO: delta query that pulls updated records for messages, stats, and schedules and order

module.exports = function(cfg) {
  const prefix = configPrefix;
  if (cfg) config.merge(prefix, cfg);

  if (config.get('process.name') !== false) process.title = config.get('process.name', 'batchalyzer api');

  const mount = config.get(`${prefix}.mount`, '/service/scheduler/api');
  const appName = config.get(`${prefix}.name`, 'Batchalyzer');
  const auth = config.get(`${prefix}.auth`, false);
  const sslOnly = config.get(`${prefix}.sslOnly`, true);
  const skipSslLocal = config.get(`${prefix}.skipSslLocal`, true);
  const skipAuthLocal = config.get(`${prefix}.skipAuthLocal`, true);
  const client = config.get(`${prefix}.html.client`, true);
  const rootClient = config.get(`${prefix}.html.root`, true);
  const serverUrl = config.get(`${prefix}.scheduler.url`);

  if (!config.get(`${prefix}.data.module`)) {
    log.server.error('No data module specified');
    return Promise.reject(new Error('No data module specified.'));
  }

  // load data module and init
  let dataConfig = config.get(`${prefix}.data.config`, {});
  dataConfig.log = log.data;
  return require(config.get(`${prefix}.data.module`))(dataConfig).then(dao => {
    const app = koa();
    app.proxy = true;

    let server = config.get(`${configPrefix}.server`), initedServer = false;
    // if no http server provided, spin one up
    if (!server) {
      const port = config.get(`${configPrefix}.port`, 3535), host = config.get(`${configPrefix}.host`, '127.0.0.1');
      log.server.info(`Starting own HTTP server on port ${host}:${port}`);
      server = http.createServer();
      server.listen(port, host);
      initedServer = true;

      // we are providing the server, so set up request logging
      app.use(function*(next) {
        let start = +(new Date()), error;
        //log.server.info(`${this.method} ${this.path}...`);
        try {
          yield next;
        } catch (e) {
          error = e;
        }

        if (!error && this.status > 399) error = true;

        let msg = [`${this.method} ${this.path} ${error ? 'FAILED - ' + error.message : 'OK'} - ${this.status} - ${+(new Date()) - start}ms`];
        if (typeof error === 'object') {
          msg.push(error);
          msg.push(error.stack);
          if (error.status) this.status = error.status;
        }

        log.server[error ? 'error' : 'info'].apply(log.server, msg);
      });
    }

    log.server.info(`Mounting routes at ${mount}`);

    // HTML Client + auth
    if (client) {
      const assetsRE = rootClient ? new RegExp(`^(${mount})?\/(js|img|css|font)\/`) : new RegExp(`^${mount}\/(js|img|css|font)\/`);
      app.use(function*(next) {
        if ((rootClient && this.path === '/js/config.js') || this.path.replace(mount, '') === '/js/config.js') {
          this.type = 'js';
          this.body = `var config = {
    mount: '${mount}',
    name: '${appName}'
  };`;
        } else if (this.method === 'GET') {
          if (assetsRE.test(this.path)) {
            return yield* sendfile.call(this, path.join(__dirname, 'client', this.path.replace(mount, '')));
          } else return yield next;
        } else return yield next;
      });
    }

    app.use(function*(next) {
      if (sslOnly && !this.secure && !(skipSslLocal && isLocal(this))) {
        this.body = 'This page requires an SSL connection.';
        this.type = 'text';
        this.throw(400);
      }

      if (auth) {
        let ok = false;

        if (typeof auth === 'function') {
          ok = yield auth.call(this);
        } else if (auth.type === 'basic') {
          let [user, password] = new Buffer(this.headers.authorization || '', 'base64').toString('utf8').split(':');
          if (user) {
            if (typeof auth.user === 'function') ok = auth.user.call(this, user, password);
            else if (typeof auth.user === 'object') ok = auth.user[user] === password;
          }
        }

        if (!ok && !(skipAuthLocal && isLocal(this))) {
          this.set('WWW-Authenticate', `Basic realm="${auth.realm || appName || 'Batchalyzer'}"`);
          this.throw(401);
        }
      }

      return yield next;
    });

    if (client) {
      app.use(route.get(`${mount}/`, function*() {
        let f = path.join(__dirname, 'client/index.html');
        yield* sendfile.call(this, f);
      }));

      if (rootClient) {
        app.use(route.get('/', function*() {
          let f = path.join(__dirname, 'client/index.html');
          yield* sendfile.call(this, f);
        }));
      }
    }

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

    // get entries
    app.use(route.post(`${mount}/entries`, form(function*() {
      this.body = stripGenerated(yield dao.entries());
    })));

    // upsert entry
    app.use(route.post(`${mount}/entry`, form(function*() {
      let item = this.posted.item;
      if (!item.id && item.customId) {
        const i = yield dao.findCustomEntry(item.customId);
        if (i) {
          item.id = i.id;
          item.updatedAt = i.updatedAt;
        }
      }
      this.body = yield dao.putEntry(item);
    })));

    app.use(route.del(`${mount}/entry/custom/:id`, function*(id) {
      const item = yield dao.findCustomEntry(id);
      if (!item) this.throw(404);
      if (this.query.permanent === 'true') {
        this.body = yield dao.dropEntry(item);
      } else {
        // unschedule the entry
        item.schedule = {};
        this.body = yield dao.putEntry(item);
      }
    }));

    // get jobs
    app.use(route.post(`${mount}/jobs`, form(function*() {
      this.body = stripGenerated(yield dao.jobs());
    })));

    // get messages
    app.use(route.get(`${mount}/messages`, function*() {
      this.body = stripGenerated(yield dao.messages());
    }));

    // recent messages
    app.use(route.get(`${mount}/messages/recent`, function*() {
      this.body = stripGenerated(yield dao.messages({ all: true, limit: 100 }));
    }));

    // update messages
    app.use(route.post(`${mount}/message`, form(function*() {
      this.body = yield dao.message(this.posted.item);
    })));

    // get stat values
    app.use(route.get(`${mount}/stat/values`, function*() {
      this.body = stripGenerated(yield dao.currentStats());
    }));

    // get stat definitions
    app.use(route.get(`${mount}/stat/definitions`, function*() {
      this.body = stripGenerated(yield dao.statDefinitions());
    }));

    // get stats
    app.use(route.get(`${mount}/stats`, function*() {
      this.body = stripGenerated(yield dao.stats());
    }));

    // get orders for entry
    app.use(route.get(`${mount}/schedule/:schedule/orders/:entry`, function*(schedule, entry) {
      this.body = stripGenerated(yield dao.orders({ schedule, entry }));
    }));

    app.use(route.get(`${mount}/previous/orders/:entry`, function*(entry) {
      this.body = stripGenerated(yield dao.lastEntryOrders(entry));
    }));

    app.use(route.post(`${mount}/order/on/demand`, form(function*() {
      const item = this.posted.entry;
      if (!item) this.throw(400);
      this.body = stripGenerated(yield dao.putOrder({ entryId: item.id, onDemand: true }));
    })));

    // get specific order
    app.use(route.get(`${mount}/order/:id`, function*(id) {
      this.body = stripGenerated(yield dao.findOrder(id));
    }));

    // get output for order
    app.use(route.get(`${mount}/output/:order`, function*(order) {
      this.body = stripGenerated(yield dao.getOutput({ order }));
    }));

    // get last output for entry
    app.use(route.get(`${mount}/schedule/:schedule/output/:entry`, function*(schedule, entry) {
      this.body = stripGenerated(yield dao.getOutput({ schedule, entry }));
    }));

    // get commands
    app.use(route.post(`${mount}/commands`, form(function*() {
      this.body = stripGenerated(yield dao.commands());
    })));

    // upsert command
    app.use(route.post(`${mount}/command`, form(function*() {
      let item = this.posted.item;
      if (!item) this.throw(400);

      if (item.newVersion) {
        let info = yield dao.lastCommandVersion(item.name);
        item.version = info.version + 1;
      }

      this.body = yield dao.putCommand(item);
    })));

    // refresh server
    app.use(route.post(`${mount}/server/reload`, function*() {
      if (!serverUrl) this.throw(500);

      yield new Promise((ok, fail) => {
        const req = http.request(`${serverUrl}/reload`, res => {
          if (res.statusCode < 400) ok(true);
          else fail(new Error(`Unexpected response ${res.statusCode}`));
        });

        req.on('error', fail);

        req.end();
      });
      this.body = {};
    }));

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

function form(opts, fn) {
  const func = typeof opts === 'function' ? opts : fn;
  const o = typeof opts === 'function' ? fn || {} : opts;

  if (typeof func !== 'function') throw new Error('I need a function.');
  return function*() {
    this.posted = yield body(this, o);
    return yield func.apply(this, Array.prototype.slice.call(arguments, 0));
  };
}

function isLocal(ctx) {
  return ctx.ip === '127.0.0.1' || ctx.ip === '::1';
}
