'use strict';

// TODO: automatically (option) install job helper module for commands

const child = require('child_process');
const os = require('os');
const sander = require('sander');
const fspath = require('path');

const WS = require('ws');
const config = require('flapjacks').read({ name: 'batchalyzer-agent' });
const prefix = 'batchalyzer.agent';
const log = (function() {
  let pfx = config.get(`${prefix}.logPrefix`, '');
  let l = require('blue-ox');
  let general = l(pfx, 'trace');

  if (pfx) pfx += ':';

  general.client = l(`${pfx}client`, 'trace');
  general.job = l(`${pfx}job`, 'trace');
  general.stat = l(`${pfx}stat`, 'trace');
  general.command = l(`${pfx}command`, 'trace');

  return general;
})();

module.exports = function(cfg) {
  if (cfg) config.merge(prefix, cfg);
  let shutdown = false, beat, socket, backoff = 0, connected = false;
  let messageQueue = [];
  let context = { jobs: {}, commands: {}, commandPackets: {}, previous: {} };
  let drainInterval = config.get(`${prefix}.drainInterval`, 1000), heartbeatInterval = config.get(`${prefix}.heartbeat`, 50);
  let backoffStep = config.get(`${prefix}.backoffStep`, 30), backoffMax = config.get(`${prefix}.backoffMax`, 300);
  let backoffStart = config.get(`${prefix}.backoffStart`, 10);

  if (config.get('process.name') !== false) process.title = config.get('process.name', 'batchalyzer agent');

  context.runStats = config.get(`${prefix}.runStats`, true);
  context.runForkStats = !context.runStats ? false : config.get(`${prefix}.runForkStats`, true);
  context.runShellStats = !context.runStats ? false : config.get(`${prefix}.runShellStats`, true);
  context.runBuiltinStats = !context.runStats ? false : config.get(`${prefix}.runBuiltinStats`, true);
  context.runJobs = config.get(`${prefix}.runJobs`, true);
  context.runForkJobs = !context.runJobs ? false : config.get(`${prefix}.runForkJobs`, true);
  context.runShellJobs = !context.runJobs ? false : config.get(`${prefix}.runShellJobs`, true);
  context.fetchCommands = config.get(`${prefix}.fetchCommands`, true);
  context.fetchStatCommands = !context.fetchCommands ? false : config.get(`${prefix}.fetchStatCommands`, true);
  context.fetchJobCommands = !context.fetchCommands ? false : config.get(`${prefix}.fetchJobCommands`, true);
  context.maxStatTime = config.get(`${prefix}.maxStatSeconds`, 30);
  context.outputChunk = config.get(`${prefix}.outputChunkBytes`, 8192);
  context.commandPath = config.get(`${prefix}.commandPath`, 'commands');
  context.halting = false;

  context.pending = (function() {
    let res = { pending: 0 };
    let listeners = [];

    res.add = function() { res.pending++; };
    res.done = function() {
      res.pending--;
      if (res.pending === 0) {
        listeners.forEach(l => process.nextTick(() => l()));
      }
    };
    res.onDrain = function(cb) {
      listeners.push(cb);
    };

    return res;
  })();

  function connect() {
    socket = new WS(config.get(`${prefix}.server`), {
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
          let j = data.data;
          if (j.id && context.jobs[j.id] && context.jobs[j.id].process) {
            log.job.info(`Got a request to send ${j.signal || 'SIGTERM'} to j.id`);
            context.jobs[j.id].process.kill(j.signal || 'SIGTERM');
          }
          break;

        case 'info':
          const versions = process.versions;
          versions.agent = JSON.parse(sander.readFileSync(__dirname, 'package.json')).version || '0.0.0';
          // TODO: return crap that's available based on config and machine
          fire('info', {
            processors: os.cpus().length, memory: os.totalmem(), os: {
              platform: os.platform(), arch: os.arch(), release: os.release()
            }, hostname: os.hostname(),
            versions,
            run: {
              stats: context.runStats,
              forkStats: context.runForkStats,
              shellStats: context.runShellStats,
              builtinStats: context.runBuiltinStats,
              jobs: context.runJobs,
              forkJobs: context.runForkJobs,
              shellJobs: context.runShellJobs
            },
            command: {
              fetch: context.fetchCommands,
              fetchStat: context.fetchStatCommands,
              fetchJob: context.fetchJobCommands
            }
          });
          break;

        case 'command':
          log.command.trace(`Got a command packet with ${!!context.commandPackets[data.data.name + '/' + data.data.version] ? 'a' : 'no'} callback.`, data.data);
          let c = data.data, next = context.commandPackets[`${c.name}/${c.version}`];
          if (next) {
            if (c.error) next.fail(c.error);
            else next.ok(c);
          }
          break;

        case 'previous':
          const m = data.data, pr = context.previous[`${m.request.id}_${m.request.success}_${m.request.fail}_${m.request.other}`];
          log.job.trace(`Got a previous response for ${m.request.id} that ${pr ? 'matches' : 'doesn\'t match'}: ${m.previous ? 'yep' : 'nope'}`, m.request);
          if (pr) {
            if (m.previous) pr.ok(m.previous);
            else pr.fail('Not Found');
          }
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
  let control = {
    close() {
      if (beat) clearTimeout(beat);
      beat = undefined;
      shutdown = true;
      if (socket) socket.close();
      process.exit();
    }
  };

  process.on('SIGINT', () => {
    function drainQueue() {
      if (messageQueue.length > 0) {
        log.client.warn('Waiting on message queue to drain...');
        setTimeout(drainQueue, 10000);
      } else {
        done();
      }
    }

    function done() {
      log.client.info('Shutdown complete.');
      control.close();
    }

    if (!context.halting) {
      log.client.info('Gracefully shutting down...');
      context.halting = true;
      if (connected) context.getFire()('halting');

      if (context.pending.pending > 0) {
        context.pending.onDrain(() => {
          drainQueue();
        });
      } else drainQueue();
    } else if (!context.forceHalting) {
      log.client.info('Less gracefully shutting down...');
      context.forceHalting = true;
      drainQueue();
    } else {
      log.client.info('Forcibly shuffing down...');
      done();
    }
  });

  return control;
};
// task types: stat (mem, disk, etc - predefined or shell), script (js-only job), or process (collect stdout and stderr separately) - probably have some sort of expect thing to make process automation easy

function getStat(context, data) {
  let p, timeout;
  log.stat.trace(`Got a stat request for ${data.type} ${data.cmd || 'builtin'}`);

  if (!context.runStats) return context.getFire()('stat', { id: data.id, type: data.type, error: 'Stats Not Supported' });
  if (!context[(data.type === 'fork' ? 'runForkStats' : data.type === 'shell' ? 'runShellStats' : 'runBuiltinStats')]) return context.getFire()('stat', { id: data.id, type: data.type, error: 'Stat Type Not Supported' });

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
      context.pending.add();
      commandAvailable(context, data, true).then((cmd) => {
        try {
          let args = [];
          if (data.args) args = args.concat(data.args);
          p = child.fork(data.cmd, args, {
            cwd: cmd.path || data.path || os.tmpdir(),
            silent: true,
            env: data.env || {}
            // TODO: uid, gid
          });

          p.on('message', msg => {
            log.stat.trace(`Stat ${data.type} ${data.cmd || 'builtin'} complete as ${msg.value}`);
            context.pending.done();
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
              context.pending.done();
              context.getFire()('stat', { error: 'timeout' });
            }, (data.limit || context.maxStatTime) * 1000);
          }
        } catch (e) {
          log.stat.error(e);
          context.pending.done();
          context.getFire()('stat', { id: data.id, error: e.message });
        }
      }, e => {
        log.stat.error(e);
        context.pending.done();
        context.getFire()('stat', { id: data.id, error: e.message });
      });
      break;

    case 'shell':
      context.pending.add();
      commandAvailable(context, data, true).then((cmd) => {
        try {
          let args = [];
          if (data.args) args = args.concat(data.args);
          p = child.spawn(data.cmd, args, {
            cwd: cmd.path || data.path || os.tmpdir(),
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
                context.pending.done();
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
              context.pending.done();
              context.getFire()('stat', { error: 'timeout' });
            }, (data.limit || context.maxStatTime) * 1000);
          }
        } catch (e) {
          log.stat.error(e);
          context.pending.done();
          context.getFire()('stat', { id: data.id, error: e.message });
        }
      }, e => {
        log.stat.error(e);
        context.pending.done();
        context.getFire()('stat', { id: data.id, error: e.message });
      });
      break;
  }
}

function runJob(context, data) {
  // TODO: white/black list for cmd
  log.job.trace(`Got a job request for ${data.type} ${data.cmd || '<unknown>'}`);

  if (!context.runJobs) return context.getFire()('job', { id: data.id, type: data.type, error: 'Jobs Not Supported' });
  if (!context[data.type === 'fork' ? 'runForkJobs' : 'runShellJobs']) return context.getFire()('job', { id: data.id, type: data.type, error: 'Job Type Not Supported' });


  if (data.type === 'fork') { // node script
    context.pending.add();
    commandAvailable(context, data, false).then((cmd) => {
      try {
        let args = [];
        if (data.args) args = args.concat(data.args);
        let p = child.fork(data.cmd, args, {
          cwd: cmd.path || data.path || os.tmpdir(),
          silent: true,
          env: data.env || {}
          // TODO: uid, gid
        });

        chunkStream(p.stdout, context.outputChunk, chunk => context.getFire()('output', { id: data.id, type: 'output', output: chunk }));
        chunkStream(p.stderr, context.outputChunk, chunk => context.getFire()('output', { id: data.id, type: 'error', output: chunk }));

        p.on('error', e => {
          if (data.id) delete context.jobs[data.id];
          log.job.error(e);
          context.pending.done();
          context.getFire()('done', { id: data.id, result: 1, error: e.message });
        });

        p.on('message', msg => {
          try {
            msg = JSON.parse(msg);
          } catch (e) {
            log.job.error(`Invalid message from process ${p.pid} job ${data.id}`, e);
            return;
          }

          log.job.trace(`Got a message for ${data.cmd}`, msg);
          switch (msg.message) {
            case 'previous':
              msg.data.id = data.id;
              log.job.trace(`Requesting previous for ${data.id}`, msg.data);
              let pv = msg.data, ok, fail, pr = new Promise((y, n) => {
                ok = (o) => {
                  delete context.previous[`${pv.id}_${pv.success}_${pv.fail}_${pv.other}`];
                  log.job.trace(`Sending requested previous order for ${pv.id}`);
                  y(o);
                };
                fail = (err) => {
                  delete context.previous[`${pv.id}_${pv.success}_${pv.fail}_${pv.other}`];
                  log.job.trace(`Sending no previous order message for ${pv.id}`);
                  n(err);
                };
              });
              context.previous[`${pv.id}_${pv.success}_${pv.fail}_${pv.other}`] = { ok, fail };
              pr.then(
                o => p.send(JSON.stringify({ message: 'previous', previous: o })),
                () => p.send(JSON.stringify({ message: 'previous' }))
              );
              context.getFire()('fetchPrevious', pv);
              break;

            case 'message':
              msg.data.orderId = data.id;
              log.job.trace(`${data.id} sending message`, msg.data);
              context.getFire()('message', msg.data);
              break;

            case 'step':
              log.job.trace(`${data.id} sending step`);
              context.getFire()('step', { id: data.id, step: msg.data });
              break;

            default:
              log.job.warn(`Unknown message from process ${p.pid} job ${data.id}: ${msg.action}`);
              break;
          }
        });
        p.send(JSON.stringify({ message: 'config', config: data.config || {} }));

        p.on('exit', (code, sig) => {
          log.job.trace(`Job done for ${data.type} ${data.cmd || '<unknown>'} result ${code}`);
          context.pending.done();
          context.getFire()('done', { id: data.id, result: code === null ? 128 + signum(sig) : code });
          if (data.id) delete context.jobs[data.id];
        });

        if (data.id) context.jobs[data.id] = { process: p, data };
      } catch (e) {
        log.job.error(e);
        context.pending.done();
        context.getFire()('done', { id: data.id, result: 1, error: e.message });
      }
    }, e => {
      log.job.error(e);
      context.pending.done();
      context.getFire()('done', { id: data.id, result: 1, error: e.message });
    });
  } else if (data.type === 'shell') { // shell script or other executable
    context.pending.add();
    commandAvailable(context, data, false).then((cmd) => {
      try {
        let args = [];
        if (data.args) args = args.concat(data.args);
        let p = child.spawn(data.cmd, args, {
          cwd: cmd.path || data.path || os.tmpdir(),
          stdio: 'pipe',
          env: data.env || {}
          // TODO: uid, gid
        });

        p.on('error', e => {
          if (data.id) delete context.jobs[data.id];
          log.job.error(e);
          context.pending.done();
          context.getFire()('done', { id: data.id, result: 1, error: e.message });
        });

        chunkStream(p.stdout, context.outputChunk, chunk => context.getFire()('output', { id: data.id, type: 'output', output: chunk }));
        chunkStream(p.stderr, context.outputChunk, chunk => context.getFire()('output', { id: data.id, type: 'error', output: chunk }));

        p.on('exit', (code, sig) => {
          log.job.trace(`Job done for ${data.type} ${data.cmd || '<unknown>'} result ${code}`);
          context.getFire()('done', { id: data.id, result: code === null ? 128 + signum(sig) : code });
          context.pending.done();
          if (data.id) delete context.jobs[data.id];
        });

        if (data.id) context.jobs[data.id] = { process: p, data };
      } catch (e) {
        log.job.error(e);
        context.pending.done();
        context.getFire()('done', { id: data.id, result: 1, error: e.message });
      }
    }, e => {
      log.job.error(e);
      context.pending.done();
      context.getFire()('done', { id: data.id, result: 1, error: e.message });
    });
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

function loadCommand(context, cmd) {
  const lock = '__command_lock', name = `${cmd.name}/${cmd.version}`, base = fspath.join(context.commandPath, cmd.name, '' + cmd.version);
  // check for already pending command
  return sander.stat(base, lock).then(() => {
    log.command.info(`Command ${cmd.name}/${cmd.version} is already being loaded.`);
    return context.commands[name];
  }, () => {
    return sander.stat(base).then(
      () => true,
        () => {
        log.command.info(`New command ${cmd.name}/${cmd.version} is being set up.`);
        sander.writeFileSync(base, lock, '');
        let wok, wfail, cok, cfail,
        wholepr = new Promise((y, n) => {
          wok = function() {
            log.command.info(`Command setup for ${cmd.name}/${cmd.version} success.`);
            delete context.commands[name];
            sander.unlinkSync(base, lock);
            y();
          };
          wfail = function(err) {
            log.command.error(`Command setup for ${cmd.name}/${cmd.version} failed.`, err);
            delete context.commands[name];
            sander.rimrafSync(base);
            n(err);
          };
        }),
        compr = new Promise((y, n) => {
          cok = function(c) {
            delete context.commandPackets[name];
            log.command.trace(`Command fetch succeded`);
            y(c);
          };
          cfail = function(err) {
            delete context.commandPackets[name];
            log.command.trace(`Command fetch failed`, err);
            n(err);
          };
        });
        context.commands[name] = wholepr;
        context.commandPackets[name] = { ok: cok, fail: cfail };

        // TODO: set a timeout to fail the promise here if there server doesn't respond in a reasonable time? (3min?)
        context.getFire()('fetchCommand', { name: cmd.name, version: cmd.version });

        compr.then(c => {
          log.command.trace(`Processing command from server...`);

          // make sure the command doesn't get outsie its box
          for (let i = 0; i < c.files.length; i++) {
            if (fspath.join(base, c.files[i].name).indexOf(base) !== 0) {
              log.command.error(`Refusing to write out of command path: ${fspath.join(base, c.files[i].name)}`);
              throw new Error(`Attept to write outside command path: ${fspath.join(base, c.files[i].name)}`);
            }
          }

          const q = [];
          for (let i = 0; i < c.files.length; i++) {
            log.command.trace(`Writing file ${fspath.join(base, c.files[i].name)}...`);
            q.push(sander.writeFile(base, c.files[i].name, c.files[i].content, { encoding: c.files[i].encoding === 'binary' ? null : c.files[i].encoding || 'utf8', mode: c.files[i].mode || '0755' }));
          }

          return Promise.all(q).then(() => {
            if (c.init && c.init.length > 0) {
              const next = function() {
                let w = c.init.shift();
                if (w) {
                  return exec(base, w.cmd, w.args).then(r => {
                    if ((c.result || [0]).indexOf(r) !== -1) return next();
                    else throw new Error(`${cmd} returned an unacceptable result ${r} (not in ${c.result || [0]}).`);
                  });
                } else return Promise.resolve(true);
              };

              next().then(wok, wfail);
            } else {
              wok();
            }
          }, wfail);
        }, wfail).then(null, wfail);

        return wholepr;
      }
    );
    }
  );
}

function exec(path, cmd, args) {
  args = args || [];
  if (!Array.isArray(args)) args = [args];
  let ok, fail, p = child.spawn(cmd, args || [], { stdio: 'ignore', cwd: path });
  let pr = new Promise((y, n) => { ok = y; fail = n; });
  p.on('error', e => fail(e));
  p.on('exit', c => ok(c));
  return pr;
}

function commandAvailable(context, item, stat = false) {
  const iscmd = !!item.command;
  if (!iscmd) return Promise.resolve({});
  if (!context.fetchCommands || (stat && !context.fetchStatCommands) || (!stat && !context.fetchJobCommands)) return Promise.reject(`Fetching is not configured for ${stat ? 'stat' : 'job'} ${item.command.name}.`);

  return loadCommand(context, item.command).then(() => { return { path: fspath.join(context.commandPath, item.command.name, '' + item.command.version) }; });
}

const signals = { SIGHUP: 0, SIGINT: 1, SIGQUIT: 3, SIGABRT: 6, SIGKILL: 9, SIGALRM: 14, SIGTERM: 15 };
function signum(sig) {
  if (typeof sig === 'number') return sig;
  sig = signals[sig];
  return sig === undefined ? -1 : sig;
}
