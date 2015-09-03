'use strict';

// TODO: allow server to provide scripts for client to run
//  cache scripts and check cached version against target

var child = require('child_process');
var os = require('os');

var ws = require('ws');
var config = require('flapjacks').read({ name: 'batchalyzer-agent' });
var prefix = 'batchalyzer.agent';
var log = (function() {
  let pfx = config.get(`${prefix}.logPrefix`, '');
  let l = require('blue-ox');
  let general = l(pfx, 'trace');

  if (pfx) pfx += ':';

  general.client = l(`${pfx}client`, 'trace');
  general.job = l(`${pfx}job`, 'trace');
  general.stat = l(`${pfx}stat`, 'trace');

  return general;
})();

module.exports = function(cfg) {
  if (cfg) config.merge(prefix, cfg);
  let shutdown = false, beat, socket, backoff = 0, connected = false;
  let messageQueue = [];
  let context = { jobs: {} };
  let drainInterval = config.get(`${prefix}.drainInterval`, 1000), heartbeatInterval = config.get(`${prefix}.heartbeat`, 50);
  let backoffStep = config.get(`${prefix}.backoffStep`, 30), backoffMax = config.get(`${prefix}.backoffMax`, 300);
  let backoffStart = config.get(`${prefix}.backoffStart`, 10);

  context.runStats = config.get(`${prefix}.runStats`, true);
  context.runForkStats = !context.runStats ? false : config.get(`${prefix}.runForkStats`, true);
  context.runShellStats = !context.runStats ? false : config.get(`${prefix}.runShellStats`, true);
  context.runBuiltinStats = !context.runStats ? false : config.get(`${prefix}.runBuiltinStats`, true);
  context.runJobs = config.get(`${prefix}.runJobs`, true);
  context.runForkJobs = !context.runJobs ? false : config.get(`${prefix}.runForkJobs`, true);
  context.runShellJobs = !context.runJobs ? false : config.get(`${prefix}.runShellJobs`, true);
  context.maxStatTime = config.get(`${prefix}.maxStatSeconds`, 30);
  context.outputChunk = config.get(`${prefix}.outputChunkBytes`, 8192);

  function connect() {
    socket = new ws(config.get(`${prefix}.server`), {
      headers: {
        Agent: config.get(`${prefix}.agent`),
        Key: config.get(`${prefix}.key`)
      }
    });

    let socketFire = function(action, data) {
      let obj = { action };
      if (data) obj.data = data;
      socket.send(JSON.stringify(obj));
    };
    let queueFire = function(action, data) {
      messageQueue.push([action, data]);
    }, fire = socketFire;
    function getFire() { return fire; }
    context.getFire = getFire;

    // fire queued messages without insta-flooding the server
    function drainQueue() {
      let item = messageQueue.shift();
      if (item) {
        setTimeout(() => {
          if (connected) {
            fire.apply(this, item);
            drainQueue();
          } else {
            messageQueue.unshift(item);
          }
        }, drainInterval);
      }
    }

    socket.on('message', (data, flags) => {
      try {
        data = JSON.parse(data);
      } catch (e) {
        log.client.error('Invalid message', e);
        return;
      }

      switch (data.action) {
        case 'stat':
          getStat(context, data.data);
          break;

        case 'job':
          runJob(context, data.data);
          break;

        case 'signal':
          // TODO: signal or kill a job
          break;

        case 'info':
          // TODO: return crap that's available based on config and machine
          fire('info', {
            processors: os.cpus().length, memory: os.totalmem(), os: {
              platform: os.platform(), arch: os.arch(), release: os.release()
            }, hostname: os.hostname(),
            run: {
              stats: context.runStats,
              forkStats: context.runForkStats,
              shellStats: context.runShellStats,
              builtinStats: context.runBuiltinStats,
              jobs: context.runJobs,
              forkJobs: context.runForkJobs,
              shellJobs: context.runShellJobs
            }
          });
          break;

        default:
          log.client.warn('Got an unknown message from the server.');
          break;
      }
    });

    socket.on('open', () => {
      connected = true;
      fire = socketFire;
      log.client.info('Successfully connected to scheduler.');
      log.client.info(`Setting up heartbeat for ${heartbeatInterval} seconds.`);
      function heartbeat() {
        if (shutdown) {
          beat = undefined;
          return;
        }

        log.client.trace('Sending heartbeat');
        fire('heartbeat');
        beat = setTimeout(heartbeat, heartbeatInterval * 1000);
      }
      heartbeat();

      drainQueue();
    });

    socket.on('error', err => {
      log.client.error(err);
      if (!shutdown && !connected) {
        if (err.message.indexOf('(503)') !== -1) {
          // TODO: check queue before bailing
          log.client.error('The server says this agent is already connected. Bailing...');
          process.exit(10);
        }
        // set messages to queue
        fire = queueFire;

        // TODO: make configurable
        if (backoff < backoffMax * 1000) { // if less than 5 minutes, add 30 seconds
          backoff += backoffStep * 1000;
        }
        log.client.info(`Trying to reconnect in ${backoff/1000} seconds...`);
        setTimeout(connect, backoff);
      }
    });

    socket.on('close', () => {
      connected = false;

      // set messages to queue
      fire = queueFire;

      // stop sending heartbeats
      if (beat) clearTimeout(beat);

      if (!shutdown) {
        socket = undefined;
        // TODO: start trying to reconnect with backoff
        log.client.info('Disconnected from server.');
        backoff = backoffStart * 1000;
        log.client.info(`Trying to reconnect in ${backoff/1000} seconds...`);
        setTimeout(connect, backoff);
      }
    });
  }

  // start
  connect();

  // return control object
  return {
    close() {
      if (beat) clearTimeout(beat);
      beat = undefined;
      shutdown = true;
      if (socket) socket.close();
    }
  };
};
// task types: stat (mem, disk, etc - predefined or shell), script (js-only job), or process (collect stdout and stderr separately) - probably have some sort of expect thing to make process automation easy

function getStat(context, data) {
  let p, timeout;
  log.stat.trace(`Got a stat request for ${data.type} ${data.cmd || 'builtin'}`);

  if (!context.runStats) context.getFire()('stat', { id: data.id, type: data.type, error: 'Stats Not Supported' });
  if (!context[(data.type === 'fork' ? 'runForkStats' : data.type === 'shell' ? 'runShellStats' : 'runBuiltinStats')]) context.getFire()('stat', { id: data.id, type: data.type, error: 'Stat Type Not Supported' });

  switch (data.type) {
    case 'mem':
      let total = os.totalmem(), free = os.freemem(), pct = 100 - ((free / total) * 100), status;
      context.getFire()('stat', { id: data.id, type: data.type, value: pct, status: `${pct}% used. ${total} total - ${total - free} used - ${free} free` });
      break;

    case 'load':
      let load = os.loadavg()[data.time === 5 ? 0 : data.time === 10 ? 1 : 2];
      context.getFire()('stat', { id: data.id, type: data.type, value: load, status: `${data.time || 15} minute load average - ${load}` });
      break;

    case 'uptime':
      break;

    case 'fork':
      try {
        let args = [];
        if (data.args) args.concat(data.args);
        p = child.fork(data.cmd, args, {
          cwd: data.path || os.tmpdir(),
          silent: true,
          env: data.env || {}
          // TODO: uid, gid
        });

        p.on('message', msg => {
            log.stat.trace(`Stat ${data.type} ${data.cmd || 'builtin'} complete as ${msg.value}`);
          context.getFire()('stat', { id: data.id, type: data.type, value: msg.value || 0, status: msg.status || '' });
          p.disconnect();
        });
        p.send({ type: 'config', config: data.config || {} });

        p.on('exit', () => {
          if (timeout) clearTimeout(timeout);
        });

        if (!('limit' in data) || (typeof data.limit === 'number' && data.limit > -1)) {
          timeout = setTimeout(() => {
            p.kill();
            log.stat.trace(`Stat ${data.type} ${data.cmd || 'builtin'} cancelled due to timeout`);
            context.getFire()('stat', { error: 'timeout' });
          }, (data.limit || context.maxStatTime) * 1000);
        }
      } catch (e) {
        log.stat.error(e);
        context.getFire()('stat', { id: data.id, error: e.message });
      }
      break;

    case 'shell':
      try {
        let args = [];
        if (data.args) args.concat(data.args);
        p = child.spawn(data.cmd, args, {
          cwd: data.path || os.tmpdir(),
          stdio: ['pipe', 'pipe', 'ignore'],
          env: data.env || {}
          // TODO: uid, gid
        });
        let buffer = '', killed = false;

        chunkStream(p.stdout, context.outputChunk, c => buffer += c);

        p.on('exit', () => {
          if (!killed) {
            let lines = buffer.split('\n');
            if (lines.length < 1) {
              context.getFire()('stat', { id: data.id, type: data.type, error: 'No result' });
            } else {
              let line = lines.pop(), value, status;
              while (line === '') line = lines.pop();
              if (line.indexOf(';') !== -1) {
                [value, status] = line.split(';');
                value = +value;
              } else {
                value = +line;
                status = '';
              }
              log.stat.trace(`Stat ${data.type} ${data.cmd || 'builtin'} complete as ${value}`);
              context.getFire()('stat', { id: data.id, type: data.type, value, status });
            }
            if (timeout) clearTimeout(timeout);
          }
        });

        if (!('limit' in data) || (typeof data.limit === 'number' && data.limit > -1)) {
          timeout = setTimeout(() => {
            killed = true;
            p.kill();
            log.stat.trace(`Stat ${data.type} ${data.cmd || 'builtin'} cancelled due to timeout`);
            context.getFire()('stat', { error: 'timeout' });
          }, (data.limit || context.maxStatTime) * 1000);
        }
      } catch (e) {
        log.stat.error(e);
        context.getFire()('stat', { id: data.id, error: e.message });
      }
      break;
  }
}

// TODO: job/process registry so scheduler can cause job to abort
function runJob(context, data) {
  // TODO: white/black list for cmd
  log.job.trace(`Got a job request for ${data.type} ${data.cmd || '<unknown>'}`);

  if (!context.runJobs) context.getFire()('job', { id: data.id, type: data.type, error: 'Jobs Not Supported' });
  if (!context[data.type === 'fork' ? 'runForkStats' : 'runShellStats']) context.getFire()('job', { id: data.id, type: data.type, error: 'Job Type Not Supported' });


  if (data.type === 'fork') { // node script
    // allow process to send certain things back to scheduler
    try {
      let args = [];
      if (data.args) args.concat(data.args);
      let p = child.fork(data.cmd, args, {
        cwd: data.path || os.tmpdir(),
        silent: true,
        env: data.env || {}
        // TODO: uid, gid
      });

      chunkStream(p.stdout, context.outputChunk, chunk => context.getFire()('output', { id: data.id, type: 'output', output: chunk }));
      chunkStream(p.stderr, context.outputChunk, chunk => context.getFire()('output', { id: data.id, type: 'error', output: chunk }));

      p.on('error', e => {
        if (data.id) delete context.jobs[data.id];
        log.job.error(e);
        context.getFire()('done', { id: data.id, result: 1, error: e.message });
      });

      p.on('message', msg => {
        // TODO: allow steps, messages, etc here
        log.job.job.trace(`Got a message for ${data.cmd}`, msg);
      });
      p.send(JSON.stringify({ message: 'config', config: data.config || {} }));

      p.on('exit', code => {
        log.job.trace(`Job done for ${data.type} ${data.cmd || '<unknown>'} result ${code}`);
        context.getFire()('done', { id: data.id, result: code });
        if (data.id) delete context.jobs[data.id];
      });

      if (data.id) context.jobs[data.id] = { procees: p, data };
    } catch (e) {
      log.job.error(e);
      context.getFire()('done', { id: data.id, result: 1, error: e.message });
    }
  } else if (data.type === 'shell') { // shell script or other executable
    try {
      let args = [];
      if (data.args) args.concat(data.args);
      let p = child.spawn(data.cmd, args, {
        cwd: data.path || os.tmpdir(),
        stdio: 'pipe',
        env: data.env || {}
        // TODO: uid, gid
      });

      p.on('error', e => {
        if (data.id) delete context.jobs[data.id];
        log.job.error(e);
        context.getFire()('done', { id: data.id, result: 1, error: e.message });
      });

      chunkStream(p.stdout, context.outputChunk, chunk => context.getFire()('output', { id: data.id, type: 'output', output: chunk }));
      chunkStream(p.stderr, context.outputChunk, chunk => context.getFire()('output', { id: data.id, type: 'error', output: chunk }));

      p.on('exit', code => {
        log.job.trace(`Job done for ${data.type} ${data.cmd || '<unknown>'} result ${code}`);
        context.getFire()('done', { id: data.id, result: code });
        if (data.id) delete context.jobs[data.id];
      });

      if (data.id) context.jobs[data.id] = { procees: p, data };
    } catch (e) {
      log.job.error(e);
      context.getFire()('done', { id: data.id, result: 1, error: e.message });
    }
  }
}

function chunkStream(stream, size, cb) {
  let buffer = '';
  if (!stream) return;
  stream.setEncoding('utf8');
  function flushBuffer(last) {
    let buf;
    // drain stream
    while ((buf = stream.read())) {
      buffer += buf;
    }

    // fire output chunks
    while (buffer.length >= size) {
      cb(buffer.substr(0, size));
      buffer = buffer.substr(size);
    }

    // flush buffer on final chunk
    if (last && buffer.length > 0) {
      cb(buffer);
      buffer = '';
    }
  }
  stream.on('readable', flushBuffer);
  stream.on('end', () => flushBuffer(true));
}
