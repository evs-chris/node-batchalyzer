var r = new Ractive({
  el: '#main',
  template: '#tpl',
  data: {
    filter: {
      date(v) { return new Date(v); },
      dateString(v) {
        if (Object.prototype.toString.call(v) !== '[object Date]') v = new Date(v);
        return `${v.getFullYear()}-${v.getMonth() + 1}-${v.getDate()}`;
      }
    }
  },
  refresh, refreshAgents, refreshMessages, refreshResources, refreshSchedules
});

var xhr = XHRAsPromised['default']({});

function refreshAgents() { return xhr.json(`${config.mount}/agents`).then(as => r.set('agents', as)); }
function refreshMessages() { return xhr.json(`${config.mount}/messages`).then(ms => r.set('messages', ms)); }
function refreshResources() { return xhr.json(`${config.mount}/resources`).then(rs => r.set('resources', rs)); }
function refreshSchedules() { return xhr.json(`${config.mount}/schedules`).then(ss => r.set('schedules', ss)); }
function refresh() { return Promise.all([refreshAgents(), refreshMessages(), refreshResources(), refreshSchedules()]); }

refresh();
