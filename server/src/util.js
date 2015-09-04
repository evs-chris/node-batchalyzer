'use strict';

function lpad(str, len, chr) {
  str = '' + str;
  chr = '' + chr;
  if (str.length < len) {
    len = (len - str.length) + 1;
    return (new Array(len)).join(chr) + str;
  }
  return str;
}

function assign(dest, ...srcs) {
  for (let i = 0; i < srcs.length; i++) {
    for (let k in srcs[i]) dest[k] = srcs[i][k];
  }
  return dest;
}

function deepAssign(dest, ...srcs) {
  for (let i = 0; i < srcs.length; i++) {
    for (let k in srcs[i]) {
      if (!Array.isArray(srcs[i][k]) && typeof srcs[i][k] === 'object') {
        if (srcs[i][k]) {
          dest[k] = deepAssign(dest[k] || {}, srcs[i][k]);
        }
      } else {
        dest[k] = srcs[i][k];
      }
    }
  }
  return dest;
}

function nextTime(target, obj, schedule) {
  let now = new Date();
  if (target > now || target.getDate() !== now.getDate()) return; // not the right day

  if (schedule.time) {
    let dt = new Date(schedule.time);
    if (dt > now && zeroDate(dt) == zeroDate(now)) return now;
    else return;
  } else if (schedule.fuzzy) {
    // fuzzy times, like last wednesday of every month, etc
    // TODO: support fuzzy times
    return;
  } else if (schedule.CRON) {
    // TODO: support other aliases
    let c = schedule.CRON;
    if ('M' in c && !inRange(c.M, now.getMonth() + 1)) return;
    if ('d' in c && !inRange(c.d, now.getDate() + 1)) return;
    if ('w' in c && !inRange(c.w, now.getDay())) return;

    if (!schedule.interval) {
      let offset = 0, overflow;
      if (true) {
        let range = nextInRange(now.getMinutes(), c.m || 0, 0, 59), next;
        if (!range) return;
        next = range[0];
        overflow = range[1];
        offset += next * 60 * 1000;
      }
      if ('h' in c) {
        let range = nextInRange(now.getHours() + (overflow ? 1 : 0), c.h, 0, 23), next;
        // check for miss or overflow
        if (!range || range[1]) return;
        next = range[0];
        offset += next * 60 * 60 * 1000;
      }

      return new Date(+zeroDate(now) + offset);
    }
  }

  // check to see if it's an interval (possibly in addition to something else)
  if (schedule.interval) {
    // interval pattern - initialoffset,interval || initialoffset[, next offset... resets to interval at end of list]
    let offsets = ('' + schedule.interval).split(',').map(t => +t);
    if (offsets.length < 1) return;
    if (obj.intervalIndex === undefined) {
      obj.intervalIndex = 1;
      let res = addTime(now, offsets[0]);
      if (res.getDate() === now.getDate()) return res;
    } else if (obj.intervalIndex >= offsets.length) {
      if (offsets.length > 1) {
        let res = addTime(now, offsets[1]);
        if (res.getDate() === now.getDate()) return res;
      } else {
        obj.intervalIndex = 1;
        let res = addTime(now, offsets[0]);
        if (res.getDate() === now.getDate()) return res;
      }
    } else {
      obj.intervalIndex++;
      let res = addTime(now, offsets[obj.intervalIndex - 1]);
      if (res.getDate() === now.getDate()) return res;
    }
  }
}

function inRange(value, range) {
  if (!Array.isArray(range)) range = [range];
  try {
    for (let i = 0; i < range.length; i++) {
      if (range[i] === undefined || range[i] === null) continue;
      if (range[i] === '*') return true;
      else if (('' + range[i]).indexOf('-')) {
        let [min, max] = ('' + range[i]).replace(/\s*/g, '').split('-').map(n => +n);
        if (value >= min && value <= max) return true;
      } else if (value === +range[i]) return true;
    }
  } catch (e) {
    return false;
  }
}

// returns [next, overflowed]
function nextInRange(start, range, min, max) {
  if (min === undefined || max === undefined) return;
  if (!Array.isArray(range)) range = [range];
  let values = [];
  for (let i = 0; i < range.length; i++) {
    if (range[i] === undefined || range[i] === null) continue;
    if (range[i] === '*') {
      for (let j = min; j <= max; j++) {
        if (values.indexOf(j) === -1) values.push(j);
      }
      break;
    } else if (('' + range[i]).indexOf('-') > -1) {
      let [rmin, rmax] = ('' + range[i]).replace(/\s*/g, '').split('-').map(n => +n);
      if (rmax < rmin) continue;
      for (let j = rmin; j <= rmax; j++) {
        if (values.indexOf(j) === -1) values.push(j);
      }
    } else if (values.indexOf(+range[i])) values.push(+range[i]);
  }

  values.sort((l, r) => l < r ? -1 : l > r ? 1 : 0);
  if (values.length === 0) return;

  for (let i = 0; i < values.length; i++) {
    if (values[i] >= start) return [values[i], false];
  }

  // overflow
  return [values[0], true];
}

function addTime(date, seconds) {
  return new Date(date.getTime() + seconds * 1000);
}

function zeroDate(date) {
  let dt = new Date((date || new Date()).getTime());
  dt.setHours(0);
  dt.setMinutes(0);
  dt.setSeconds(0);
  dt.setMilliseconds(0);
  return dt;
}

function rand(max, min = 0) {
  return Math.floor(Math.random() * (max - min) + min);
}

function isEmptyObject(obj) {
  if (!obj) return true;
  for (let k in obj) {
    if (obj.hasOwnProperty(k) && obj[k] !== undefined) return false;
  }
  return true;
}

module.exports = {
  lpad, assign, deepAssign, inRange, nextInRange, nextTime, addTime, zeroDate, rand, isEmptyObject
};
