'use strict';

var sander = require('sander'),
    ftp = require('ftp'),
    log = require('blue-ox')('export', 'trace'),
    request = require('request-promise'),
    path = require('path'),
    _ = require('lodash'),
    argv = process.argv,
    argc = process.argv.length;
var fileConfig = false;
var tmpdir = '' + require('os').tmpdir() + '/batchjob/' + process.pid;
var base = 'https://portal.waynereaves.net';
var filters = makeFilters();

if (argc > 2 && argv[argc - 2] === '-f') {
  log.info('Reading config from ' + process.argv[argc - 1] + '...');
  fileConfig = true;
  sander.readFile(argv[argc - 1]).then(function (d) {
    var config = undefined;
    try {
      config = JSON.parse(d.toString('utf8'));
      if (config.base) base = config.base;
      start(config);
    } catch (e) {
      log.error('Error parsing config file.', d.toString('utf8'));
      log.error(e);
    }
  }, function (err) {
    return log.error(err);
  });
} else {
  (function () {
    log.info('Waiting for config messages...');
    var handler = function handler(msg) {
      msg = JSON.parse(msg);
      var type = msg.type;

      var config = undefined;

      if (type === 'config') {
        config = msg.config;
      }

      if (type === 'previous') {
        if (msg.previous) {
          config.lastRun = new Date(msg.previous.completedAt);
        }
        // unsubscribe to allow normal exit
        process.removeListener('message', handler);
        start(config);
      }
    };
    process.on('message', handler);
  })();
}

function start(config) {
  if (!config.params) config.params = {};

  var step1 = undefined,
      ok = true;
  log.info('Writing temporary files to \'' + tmpdir + '\'.');
  if (config.allAccounts) {
    (function () {
      log.info('Starting multi-account upload...');

      var step2 = function step2(setups) {
        var ss = setups.slice(0),
            fs = [];
        log.info('' + ss.length + ' setups found.');
        return function next() {
          var s = ss.shift();
          if (s) {
            s.setupId = s.id;
            log.info('Running for ' + s.id + '...');
            return runFor(s).then(function (files) {
              files.forEach(function (fl) {
                if (!_.find(fs, function (f) {
                  return f.local === fl.local;
                })) fs.push(fl);
              });
              return next();
            });
          } else return fs;
        };
      };

      if (config.thirdParty && config.setups) {
        step1 = step2(config.setups)();
      } else {
        log.info('Fetching definition for ' + config.thirdPartyId + '...');
        step1 = request.get({
          url: '' + base + '/service/thirdparty/' + config.thirdPartyId,
          json: true
        }).then(function (tp) {
          log.info('Definition retrieved');
          config.thirdParty = tp;
          log.info('Fetching setups for third party.');
          return request.get({
            url: '' + base + '/service/thirdparty/setups/' + tp.id,
            json: true
          }).then(function (ss) {
            config.setups = ss.slice(0);
            return step2(ss)();
          });
        });
      }
    })();
  } else {
    log.info('Starting single account upload...');
    config.setups = [config];
    step1 = runFor(config);
  }
  return step1.then(function (files) {
    return ftpFiles(config, files);
  }).then(function () {
    return notifyComplete(config);
  }).then(function () {
    return cleanUp();
  }, function (err) {
    ok = false;
    log.error(err);
    cleanUp();
  }).then(function () {
    log.info('Exiting with status ' + (ok ? 0 : 1) + '.');
    process.exit(ok ? 0 : 1);
  });
}

function runFor(config) {
  return getData(config).then(function (_ref) {
    var items = _ref.items;
    var accounts = _ref.accounts;

    var step1 = undefined;
    if (config.params.sendPictures) step1 = getPics(config, items);else step1 = Promise.resolve(true);

    // build file(s)
    return step1.then(function () {
      return genFiles(config, items, accounts);
    });
  });
}

function getData(config) {
  return request.get({
    uri: '' + base + '/service/thirdparty/setup/data/' + config.setupId,
    json: true
  }).then(function (res) {
    config.items = res.items;
    config.accounts = res.accounts;
    return res;
  });
}

function getPics(config, items) {
  // TODO -
  // fetch pictures and store in tmp dir
  // only pull pictures that have changed since the last sent date
  var its = items.slice(0);

  function item() {
    var i = its.shift();
    if (i) {
      var _ret3 = (function () {
        var ps = i.pictures.slice(0);

        var pic = function pic() {
          var p = ps.shift();

          if (p) {} else return true;
        };

        return {
          v: pic()
        };
      })();

      if (typeof _ret3 === 'object') return _ret3.v;
    } else return true;
  }

  return item();
}

function genFiles(config, items, accounts) {
  var q = [],
      tpls = [],
      files = config.params.files,
      firstAccount = accounts[firstKey(accounts)];
  log.info('Generating files...');

  // loop through files and generate template fns
  for (var i = 0; i < files.length; i++) {
    log.trace('compiling template for \'' + files[i].name.template + '\'');
    var tpl = files[i].content.template;
    if (files[i].content.stripNewlines) tpl = tpl.replace(/\r|\n/g, '');
    tpls.push(_.template(tpl, files[i].templateOpts || {}));
  }

  var _loop = function (i) {
    log.trace('compiling name template \'' + files[i].name.template + '\'');
    var f = files[i],
        target = _.template(f.name.template, files[i].templateOpts || {})({ filters: filters, config: config, params: config.params, accounts: accounts, firstAccount: firstAccount }),
        nm = path.join(tmpdir, target);
    log.info('Building ' + target + '...');
    if (nm.indexOf(tmpdir) !== 0) throw new Error('Can\'t write outside working tree: ' + nm);
    f.local = nm;
    f.target = target;
    q.push(sander.appendFile(nm, tpls[i]({ filters: filters, config: config, params: config.params, items: items, accounts: accounts, firstAccount: firstAccount })).then(function () {
      return f;
    }));
  };

  // loop through files, run templates, and write to tmp dir
  for (var i = 0; i < files.length; i++) {
    _loop(i);
  }

  return Promise.all(q);
}

function Promisify(fn, ctx) {
  return function () {
    for (var _len = arguments.length, args = Array(_len), _key = 0; _key < _len; _key++) {
      args[_key] = arguments[_key];
    }

    return new Promise(function (ok, fail) {
      args.push(function () {
        for (var _len2 = arguments.length, int = Array(_len2), _key2 = 0; _key2 < _len2; _key2++) {
          int[_key2] = arguments[_key2];
        }

        if (int[0]) fail(int[0]);else if (int.length === 2) ok(int[1]);else ok(int.slice(1));
      });
      fn.apply(ctx || null, args);
    });
  };
}
function ftpFiles(config, files) {
  switch (config.params.transport) {
    default:
      return new Promise(function (ok, fail) {
        var c = new ftp(),
            put = Promisify(c.put, c),
            mkdir = Promisify(c.mkdir, c); //, list = Promisify(c.list, c);

        c.on('ready', function () {
          log.info('...connected.');
          // TODO: check to see if pictures should be sent
          var fs = files.slice(0);

          function next() {
            var f = fs.shift();
            if (f) {
              log.info('Sending ' + f.local + ' -> ' + f.target + '...');
              var step = undefined;
              if (path.dirname(f.target) !== '') {
                step = mkdir(path.dirname(f.target), true);
              } else step = Promise.resolve(true);
              return step.then(function () {
                return put(f.local, f.target).then(function () {
                  return next();
                });
              });
            } else return true;
          }

          next().then(ok, fail);
        });

        c.on('error', function (err) {
          return fail(err);
        });

        c.on('close', function (err) {
          if (err) fail(err);else ok();
        });

        log.info('Connecting to ftp://' + config.params.host + ':' + (config.params.port || 21) + ' as ' + config.params.user + '...');
        c.connect({
          host: config.params.host,
          port: config.params.port || 21,
          user: config.params.user,
          password: config.params.password
        });
      });
  }
}

function cleanUp() {
  log.info('Cleaning up...');
  return sander.rimraf(tmpdir);
}

function notifyComplete(config) {
  var ss = config.setups || [];

  function next() {
    var s = ss.shift();
    if (s) {
      return request({
        method: 'post',
        uri: '' + base + '/service/thirdparty/complete/setup/' + (s.id || s.setupId),
        json: true,
        body: { items: (s.items || []).map(function (i) {
            return i.stockNo;
          }).filter(function (i) {
            return !!i;
          }) }
      }).then(function () {
        return next();
      });
    } else return true;
  }

  return next();
}

function firstKey(obj) {
  for (var k in obj) {
    return k;
  }
}

function makeFilters() {
  var decRE = /(\d)(?=(\d{3})+\.)/g;
  var intRE = /(\d)(?=(\d{3})+$)/g;
  var isNumRE = /^[-0-9\\.,]+$/;

  function number(v, dec) {
    if (typeof v === 'number') v = v.toFixed(dec !== undefined ? dec : 2);
    v = v || '';
    if (dec === 0) v = v.replace(/\..*/, '');
    return v.replace(v.indexOf('.') === -1 ? intRE : decRE, '$1,');
  }

  function currency(v, alt, dec) {
    if (v && isNumRE.test(v)) return '$' + number(v, dec);else return alt !== undefined ? alt : v;
  }

  function integer(v) {
    return number(v, 0);
  }

  function phone(v) {
    if (typeof v === 'number') v = v.toString();
    v = v || '';

    if (v.length === 7) return '' + v.substr(0, 3) + '-' + v.substr(3, 4);else if (v.length === 10) return '(' + v.substr(0, 3) + ') ' + v.substr(3, 3) + '-' + v.substr(6, 4);else if (v.length === 11) return '' + v[0] + '-' + v.substr(1, 3) + '-' + v.substr(4, 3) + '-' + v.substr(7, 4);else return v;
  }

  var dateRE = /y+|M+|d+|E+|H+|m+|s+|k+|a+/g;
  var months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  function date(v, fmt) {
    if (!v) return '';
    if (typeof v === 'string') v = new Date(v);else if (Object.prototype.toString.call(v) !== '[object Date]') return '';

    return fmt.replace(dateRE, function (m) {
      if (m[0] === 'y') {
        return m.length <= 2 ? ('' + v.getFullYear()).substr(2, 2) : '' + v.getFullYear();
      } else if (m[0] === 'M') {
        if (m.length === 1) return '' + (v.getMonth() + 1);else if (m.length === 2) return v.getMonth() < 9 ? '0' + (v.getMonth() + 1) : '' + (v.getMonth() + 1);else if (m.length === 3) return months[v.getMonth()].substr(0, 3);else return months[v.getMonth()];
      } else if (m[0] === 'd') {
        return m.length === 1 ? '' + v.getDate() : v.getDate() <= 9 ? '0' + v.getDate() : v.getDate();
      } else if (m[0] === 'E') {
        if (m.length === 1) return '' + (v.getDay() + 1);else if (m.length === 2) return days[v.getDay()].substr(0, 3);else return days[v.getDay()];
      } else if (m[0] === 'H') {
        return m.length === 1 ? '' + v.getHours() : v.getHours() <= 9 ? '0' + v.getHours() : '' + v.getHours();
      } else if (m[0] === 'm') {
        return m.length === 1 ? '' + v.getMinutes() : v.getMinutes() <= 9 ? '0' + v.getMinutes() : '' + v.getMinutes();
      } else if (m[0] === 's') {
        return m.length === 1 ? '' + v.getSeconds() : v.getSeconds() <= 9 ? '0' + v.getSeconds() : '' + v.getSeconds();
      } else if (m[0] === 'k') {
        var r = v.getHours() % 12;
        if (r === 0) r = 12;
        return '' + r;
      } else if (m[0] === 'a') {
        return v.getHours > 11 ? 'PM' : 'AM';
      }
    });
  }

  function noHtml(str) {
    str = '' + (str || '');
    return str.replace(/<.+?>/g, '');
  }

  return { date: date, phone: phone, integer: integer, currency: currency, noHtml: noHtml, number: number };
}

// check pic date

