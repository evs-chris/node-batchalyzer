import agent from './parts/agent';
import command from './parts/command';
import message from './parts/message';
import order from './parts/order';
import entry from './parts/entry';
import job from './parts/job';
import resource from './parts/resource';

Ractive.defaults.data.ensureArray = function(path) {
  if (path.indexOf('undefined') === 0) return;
  let obj = this.get(path);
  if (!Array.isArray(obj)) {
    obj = [];
    this.set(path, obj);
  }
  return obj;
};

var modals = [];

var r = new Ractive({
  el: 'main',
  template: '#tpl',
  data: {
    filter: {
      date(v) { return new Date(v); },
      dateString(v) {
        if (Object.prototype.toString.call(v) !== '[object Date]') v = new Date('' + v);
        return `${v.getFullYear()}-${_.padLeft(v.getMonth() + 1, 2, '0')}-${_.padLeft(v.getDate(), 2, '0')}`;
      },
      timestamp(v) {
        if (!v) return '<None>';
        if (Object.prototype.toString.call(v) !== '[object Date]') v = new Date('' + v);
        return `${v.getFullYear()}-${_.padLeft(v.getMonth() + 1, 2, '0')}-${_.padLeft(v.getDate(), 2, '0')} ${_.padLeft(v.getHours(), 2, '0')}:${_.padLeft(v.getMinutes(), 2, '0')}:${_.padLeft(v.getSeconds(), 2, '0')}`;
      }
    },
    orderName(i) {
      if (i.name) return i.name;
      if (i.label) return i.label;
      if (i.entry) {
        let e = i.entry;
        if (e.config.name) return e.config.name;
        if (e.config.command) return e.config.command.name;
        if (e.job) {
          let j = e.job;
          if (j.config.name) return j.config.name;
          if (j.config.command) return j.config.command.name;
        }
        if (e.config.cmd) return e.config.cmd;
        if (e.job) {
          if (e.job.config.cmd) return e.job.config.cmd;
        }
      }
      if (i.config) {
        let c = i.config;
        if (c.name) return c.name;
        if (c.command) return c.command.name;
      }
      if (i.job) {
          let j = i.job;
          if (j.config.name) return j.config.name;
          if (j.config.command) return j.config.command.name;
          if (j.config.cmd) return j.config.cmd;
      }

      return '<Unknown>';
    },
    agentName(order) {
      if (order.entry) {
        let e = order.entry;
        if (e.config.agent) return e.config.agent;
        if (_.isArray(e.config.agents)) return e.config.agents.join(', ');
        if (e.config.group) return e.config.group;
        if (_.isArray(e.config.groups)) return e.config.groups.join(', ');
        if (e.job) {
          let j = e.job;
          if (j.config.agent) return j.config.agent;
          if (_.isArray(j.config.agents)) return j.config.agents.join(', ');
          if (j.config.group) return j.config.group;
          if (_.isArray(j.config.groups)) return j.config.groups.join(', ');
        }
      }

      return '<Unknown>';
    },
    config
  },
  partials: {
    editorConfig: `<div id="editor-config" on-click="toggle('tmp.editorConfig')">&#9881;
  {{#if ~/tmp.editorConfig}}
    <div class="options" on-click="stopEvent()">
      <label><input type="checkbox" twoway="false" checked="{{~/settings.editor.wrap}}" on-click="toggle('settings.editor.wrap')" /> Word Wrap</label>
      <label><input type="checkbox" twoway="false" checked="{{~/settings.editor.vim}}" on-click="toggle('settings.editor.vim')" /> VIM Mode</label>
    </div>
  {{/if}}
</div>`,
    blocker: ''
  },
  block(opts = {}) {
    this.set('blockerClose', opts.close);
    this.resetPartial('blocker', opts.template || '');
    this.set('blocked', true);
  },
  stopEvent(prevent) {
    if (this.event) {
      let o = this.event.original;
      if (typeof o.stopPropagation === 'function') o.stopPropagation();
      if (typeof o.cancelBubble === 'function') o.cancelBubble();
      if (prevent && typeof o.preventDefault === 'function') o.preventDefault();
    }
    return false;
  },
  unblock() {
    modals.shift();

    if (modals.length > 0) {
      this.set('tmp', modals[0].data || {});
      this.block(modals[0]);
    } else {
      this.set('blocked', false);
      this.resetPartial('blocker', '');
      setTimeout(() => {
        this.set({
          blockerClose: null,
          tmp: null
        });
      }, 600);
    }
  },
  modal(opts) {
    modals.unshift(opts);
    this.set('tmp', opts.data || {});
    this.block(opts);
  },
  message(message, opts = {}) {
    this.modal({
      template: `<div class="pure-form${opts.class ? ' ' + opts.class : ''}" style="min-width: 15em;">
  <div class="title">${opts.title || 'Message'}</div><div />
  <div style="padding: 1em 0;">
    ${message}
  </div>
  <div class="pre-buttons" />
  <div class="buttons">
    <button class="pure-button pure-button-primary" on-click="blockerClose">OK</button>
  </div>
</div>`,
      close() { return true; }
    });
  },
  refresh, refreshAgents, refreshMessages, refreshRecentMessages, refreshResources, refreshSchedules, refreshStats, refreshStatDefs, refreshStatValues, refreshEntries, refreshJobs, refreshCommands
});

function refreshAgents() { return xhr.json(`${config.mount}/agents`).then(as => {
  let map = {};
  as.forEach((a, i) => map[a.id] = i);
  r.set('agents', as);
  r.set('agentMap', map);
}); }
function refreshMessages() { return xhr.json(`${config.mount}/messages`).then(ms => r.set('messages', ms)); }
function refreshRecentMessages() { return xhr.json(`${config.mount}/messages/recent`).then(ms => r.set('recentMessages', ms)); }
function refreshResources() { return xhr.json(`${config.mount}/resources`).then(rs => r.set('resources', rs)); }
function refreshSchedules() { return xhr.json(`${config.mount}/schedules`).then(ss => {
  ss = _.sortBy(ss, s => s.target);
  r.set('schedules', ss);
}); }
function refreshStatDefs() { return xhr.json(`${config.mount}/stat/definitions`).then(ds => r.set('statDefs', ds)); }
function refreshStatValues() { return xhr.json(`${config.mount}/stat/values`).then(ss => r.set('statValues', ss)); }
function refreshStats() { return xhr.json(`${config.mount}/stats`).then(ss => r.set('stats', ss)); }
function refreshEntries() { return xhr.json.post(`${config.mount}/entries`, {}).then(es => r.set('entries', es)); }
function refreshJobs() { return xhr.json.post(`${config.mount}/jobs`, {}).then(js => r.set('jobs', js)); }
function refreshCommands() { return xhr.json.post(`${config.mount}/commands`, {}).then(cs => r.set('commands', cs)); }
function refresh() {
  r.set('statDefs', null);
  r.set('stats', null);
  r.set('entries', null);
  r.set('recentMessages', null);
  r.set('commands', null);
  return Promise.all([refreshAgents(), refreshMessages(), refreshResources(), refreshSchedules(), refreshStatValues()]).then(() => {
    let tab = r.get('settings.tab');
    loadTabs(tab);
    if (tab === 'stats') loadStatsTab(r.get('settigs.statsTab.tab'));
    if (tab === 'schedules') loadSchedulesTab(r.get('settigs.schedulesTab.tab'));
  });
}

refresh();

// set up parts
agent(r);
command(r);
message(r);
order(r);
entry(r);
job(r);
resource(r);

function loadSchedulesTab(v) {
  if (v === 'entries' && !r.get('entries')) {
    r.set('entries', []);
    refreshEntries();
  } else if (v === 'jobs' && !r.get('jobs')) {
    r.set('jobs', []);
    refreshJobs();
  }
}
r.observe('settings.schedulesTab.tab', loadSchedulesTab);

function loadStatsTab(v) {
  if (v === 'stats' && !r.get('stats')) {
    r.set('stats', []);
    refreshStats();
  } else if (v === 'defs' && !r.get('statDefs')) {
    r.set('statDefs', []);
    refreshStatDefs();
  }
}
r.observe('settings.statsTab.tab', loadStatsTab);

function loadTabs(v) {
  if (v === 'commands' && !r.get('commands')) {
    r.set('commands', []);
    refreshCommands();
  } else if (v === 'messages' && !r.get('recentMessages')) {
    r.set('recentMessages', []);
    refreshRecentMessages();
  }
}
r.observe('settings.tab', loadTabs);

r.on('reloadServer', function() {
  xhr.json.post(`${config.mount}/server/reload`, {}).then(
    () => this.message('Reload successful.'),
    () => this.message('Reload failed.', { title: 'Error', class: 'error' })
  );
});

// persist settings between refreshes
if (window.localStorage) {
  r.set('settings', JSON.parse(window.localStorage.getItem('settings') || '{}'));
  r.observe('settings', _.debounce(v => {
    window.localStorage.setItem('settings', JSON.stringify(v));
  }, 2000),
  { init: false });
}

r.on('blockerClose', function(ev) {
  let fn = this.get('blockerClose');
  if (typeof fn === 'function' && !fn.call(this)) return;

  r.unblock();
});

// set up ace editor instance
r.editor = ace.edit('editor');
r.editorNode = document.querySelector('#editor');
r.editor.$blockScrolling = Infinity;
r.editor.setOptions({
  theme: 'ace/theme/monokai',
  showPrintMargin: false,
  tabSize: 2,
  useSoftTabs: true
});
(function(n) {
  n.style.position = 'absolute';
  n.style.top = 0;
  n.style.bottom = 0;
  n.style.left = 0;
  n.style.right = 0;
  n.style.display = 'none';
})(r.editorNode);

const aceModes = { js: 'javascript', html: 'html', css: 'css', styl: 'stylus', json: 'json', stylus: 'stylus', sh: 'sh' };
const fileExt = /.*\.([^\.]+)$/;
function aceDecorator(node, opts = {}) {
  node.style.position = 'relative';
  node.appendChild(r.editorNode);
  r.editorNode.style.display = 'block';
  r.editor.setValue(r.get(opts.keypath) || '');
  r.editor.clearSelection();
  r.editor.gotoLine(0, 0);
  r.editor.resize();

  if (opts.filename) {
    let ext = fileExt.exec(opts.filename);
    if (ext) ext = ext[1];
    if (ext && aceModes[ext]) {
      r.editor.setOption('mode', `ace/mode/${aceModes[ext]}`);
    } else {
      r.editor.setOption('mode', null);
    }
  }
  let listener = _.debounce(() => r.set(opts.keypath, r.editor.getValue()), 500);
  r.editor.on('change', listener);

  return {
    teardown() {
      r.editor.removeListener('change', listener);
    }
  };
}
Ractive.decorators.ace = aceDecorator;

r.observe('settings.editor.vim', v => {
  if (v) r.editor.setKeyboardHandler('ace/keyboard/vim');
  else r.editor.setKeyboardHandler(null);
});
r.observe('settings.editor.wrap', v => r.editor.setOption('wrap', !!v));

// helpful to clear dblclick selections
r.clearSelection = function() {
  if(document.selection && document.selection.empty) {
    document.selection.empty();
  } else if(window.getSelection) {
    var sel = window.getSelection();
    sel.removeAllRanges();
  }
};

Ractive.prototype.moveUpList = function() {
  let ev = this.event, path = ev.keypath.split('.'), val = this.get(ev.keypath), idx = +path.pop();
  path = path.join('.');

  this.root.splice(path, idx, 1);
  this.root.splice(path, idx - 1, 0, val);
};

Ractive.prototype.moveDownList = function() {
  let ev = this.event, path = ev.keypath.split('.'), val = this.get(ev.keypath), idx = +path.pop();
  path = path.join('.');

  this.root.splice(path, idx, 1);
  this.root.splice(path, idx + 1, 0, val);
};

Ractive.prototype.removeFromList = function() {
  let ev = this.event, path = ev.keypath.split('.'), idx = +path.pop();
  path = path.join('.');

  this.root.splice(path, idx, 1);
};

Ractive.events.dbltap = function(node, fire) {
  const time = 500;
  let touched = false, timeout, cancel;
  const handler = function ( event ) {
    // for simplicity, we'll only deal with single finger presses
    if (touched) {
      cancel();
      fire({ node, original: event });
      return;
    }

    touched = true;

    // after the specified delay, fire the event...
    timeout = setTimeout( function () {
      touched = false;
      cancel();
    }, time );

    // ...unless the timeout is cancelled
    cancel = function () {
      touched = false;
      clearTimeout( timeout );
    };
  };

  node.addEventListener( 'touchend', handler );

  // return an object with a teardown method, so we can unbind everything when the
  // element is removed from the DOM
  return {
    teardown: function () {
      node.removeEventListener( 'touchend', handler );
    }
  };
};

r.components.Schedule = Ractive.extend({
  template: `<div>
  <select value="{{~/type}}">
    <option>CRON</option>
    <option>Interval</option>
    <option>CRON + Interval</option>
  </select>
  {{#if ~/type.indexOf('CRON') !== -1}}
    {{#with ~/schedule.CRON}}
      <div class="list striped">
        <div class="middle"><span style="width: 8em;">Months:</span><button class="pure-button pure-button-secondary" on-click="unshift('schedule.CRON.M', '')">+</button>{{#each .M}}{{>'numberList'}}{{/each}}</div>
        <div class="middle"><span style="width: 8em;">Month Days:</span><button class="pure-button pure-button-secondary" on-click="unshift('schedule.CRON.d', '')">+</button>{{#each .d}}{{>'numberList'}}{{/each}}</div>
        <div class="middle"><span style="width: 8em;">Weekdays:</span><button class="pure-button pure-button-secondary" on-click="unshift('schedule.CRON.w', '')">+</button>{{#each .w}}{{>'numberList'}}{{/each}}</div>
        {{#if ~/type.indexOf('Interval') === -1}}
          <div class="middle"><span style="width: 8em;">Hours:</span><button class="pure-button pure-button-secondary" on-click="unshift('schedule.CRON.h', '')">+</button>{{#each .h}}{{>'numberList'}}{{/each}}</div>
          <div class="middle"><span style="width: 8em;">Minutes:</span><button class="pure-button pure-button-secondary" on-click="unshift('schedule.CRON.m', '')">+</button>{{#each .m}}{{>'numberList'}}{{/each}}</div>
        {{/if}}
      </div>
    {{/with}}
  {{/if}}
  {{#if ~/type.indexOf('Interval') !== -1}}
        <div class="middle"><button class="pure-button pure-button-secondary" on-click="unshift('schedule.interval', '')">+</button>{{#each ~/schedule.interval}}
          <label class="field">
            <button {{#if @index === 0}}disabled{{/if}} class="pure-button" on-click="moveUpList()">&#8678;</button>
            <button {{#if @index + 1 === ../length}}disabled{{/if}} class="pure-button" on-click="moveDownList()">&#8680;</button>
            {{#if @index === 0}}
              {{#if ../length === 1}}Interval
              {{else}}Offset{{/if}}
            {{else}}Span {{@index}}{{/if}}
            <button class="pure-button pure-button-cancel" on-click="removeFromList()"><span class="icon">&#8855;</span></button>
            <input value="{{.}}" />
          </label>
        {{/each}}</div>
  {{/if}}
</div>`,
  data() {
    return { type: 'CRON' };
  },
  oninit() {
    if (!this.get('schedule')) this.set('schedule', {});

    let cron = this.get('schedule.CRON'), interval = this.get('schedule.interval');
    if (typeof interval === 'string') {
      interval = interval.split(',');
      this.set('schedule.interval', interval);
    } else if (typeof interval === 'number') {
      interval = [interval];
      this.set('schedule.interval', interval);
    }

    this.set('type',
      cron && interval ? 'CRON + Interval' :
        interval ? 'Interval' :
        'CRON'
    );

    this.observe('type', v => {
      const ensureArray = p => {
        if (!this.get(p)) {
          this.set(p, []);
        }
      };
      if (v === 'CRON') {
        ['M', 'd', 'w', 'h', 'm'].map(k => `schedule.CRON.${k}`).forEach(ensureArray);
        this.set('schedule.interval', undefined);
      } else if (v === 'Interval') {
        ensureArray('schedule.interval');
        if (typeof this.get('schedule.interval') === 'string') this.set('schedule.interval', this.get('schedule.interval').split(','));
        this.set('schedule.CRON', undefined);
      } else if (v === 'CRON + Interval') {
        ['M', 'd', 'w'].map(k => `schedule.CRON.${k}`).forEach(ensureArray);
        ensureArray('schedule.interval');
        if (typeof this.get('schedule.interval') === 'string') this.set('schedule.interval', this.get('schedule.interval').split(','));
      }
    });
  },
  isolated: true,
  partials: {
    numberList: `
  <label class="field">
    <button {{#if @index === 0}}disabled{{/if}} class="pure-button" on-click="moveUpList()">&#8678;</button>
    <button {{#if @index + 1 === ../length}}disabled{{/if}} class="pure-button" on-click="moveDownList()">&#8680;</button>
    Entry
    <button class="pure-button pure-button-cancel" on-click="removeFromList()"><span class="icon">&#8855;</span></button>
    <input value="{{.}}" />
  </label>
`
  }
});

document.body.addEventListener('keydown', function(ev) {
  if (ev.keyCode === 77 && ev.ctrlKey) r.toggle('settings.expandMessages');
});

export default r;
