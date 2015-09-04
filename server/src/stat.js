'use strict';

var { nextTime, zeroDate, assign, deepAssign } = require('./util');

module.exports = function(cfg, log) {
  function initStats(context) {
    let { dao } = context;
    context.stats = [];

    return dao.stats().then(ss => {
      for (let i = 0; i < ss.length; i++) {
        let s = ss[i];
        let next = nextTime(zeroDate(), s, s.config.schedule || s.definition.config.schedule);
        if (next) {
          s.next = next;
          context.stats.push(s);
          log.schedule.trace(`Scheduling ${s.definition.name} ${s.cmd || 'builtin'} for ${next}`);
        }
      }

      return context.stats;
    });
  }

  function _findStat(stats, dao, id) {
    for (let i = 0; i < stats.length; i++) {
      if (stats[i] && stats[i].id == id) return Promise.resolve(stats[i]);
    }
    return dao.findStat(id).then(s => {
      stats.push(s);
      return s;
    });
  }

  function _fireStat(context, stat) {
    let { dao, agents } = context;

    if (!stat.agentId) return Promise.resolve(false);

    return new Promise((ok, fail) => {
      let agent;
      for (let i = 0; i < agents.length; i++) {
        if (stat.agentId == agents[i].id) {
          if (!agents[i].socket) log.stat.info(`Agent ${agents[i].name} is not connected for stat ${stat.definition.name}`);
          else {
            let def = stat.definition;
            log.stat.info(`Firing ${def.name} for ${agents[i].name}`);
            agents[i].fire('stat', { id: stat.id, type: def.type, cmd: def.config.command, config: assign({}, stat.config, def.config) });
            ok();
            return;
          }
        }
      }
      log.stat.warn(`No agent found with id ${stat.agentId}`);
      fail(new Error('no agent'));
    });
    // TODO: refreshing bit to track unreturned stats?
  }

  function statComplete(context, data) {
    let { dao, findStat } = context;

    // TODO: plugin failures get an error here
    if (data.error) return;

    findStat(data.id).then(stat => {
      let state = checkValue(deepAssign({}, stat.definition.config, stat.config), data.value);
      dao.statEntry(stat, data.value, data.status, state);

      let msg = {
        handle: `stat ${stat.id} state`,
        message: `${stat.name} ${state === 0 ? 'OK' : state === 1 ? 'WARNING' : 'CRITICAL'}`
      };
      if (state === 0) msg.state = 3; // handle
      dao.message(msg);
    });
  }

  function checkValue(config, value, defaults = {}) {
    let warn = config.warn || defaults.warn || {}, crit = config.crit || defaults.crit || {}, warnLow, warnHigh = Infinity, critLow, critHigh = Infinity;

    if (typeof warn === 'number') warnLow = warn;
    else if (typeof warn === 'object') {
      if (typeof warn.low === 'number') warnLow = warn.low;
      if (typeof warn.high === 'number') warnHigh = warn.high;
    }

    if (typeof crit === 'number') critLow = crit;
    else if (typeof crit === 'object') {
      if (typeof crit.low === 'number') critLow = crit.low;
      if (typeof crit.high === 'number') critHigh = crit.high;
    }

    if (value >= critLow && value <= critHigh) {
      return 2;
    } else if (value >= warnLow && value <= warnHigh) {
      return 1;
    } else return 0;
  }

  return {
    initStats, _findStat, _fireStat, statComplete
  };
};
