export default function(r) {
  const tpl = `<div style="min-height: 80vh; min-width: 80vw;" class="pure-form flex">{{#with tmp.item}}
  <div class="title">Job - {{.name}}</div><div />
  <div class="flex primary" style="overflow: auto;">
    <div class="content flex">
      <div class="tabs"><div>
        <div class="tab{{#if ~/tmp.tab === 'details' || !~/tmp.tab}} selected{{/if}}" on-click="set('tmp.tab', 'details')">Details</div>
        <div class="tab{{#if ~/tmp.tab === 'previous'}} selected{{/if}}" on-click="set('tmp.tab', 'schedule')">Schedule</div>
      </div></div>

      {{#if ~/tmp.tab === 'details' || !~/tmp.tab}}
        <div class="flex primary">
          <label>Config</label>
          <textarea class="primary" twoway="false" on-change="newConfig:job">{{JSON.stringify(.config, null, '  ')}}</textarea>
        </div>
      {{/if}}

      {{#if ~/tmp.tab === 'schedule'}}
        <div>
          <Schedule schedule="{{.schedule}}"/>
        </div>
      {{/if}}
    </div>
  </div>
  <div class="pre-buttons" />
  <div class="buttons">
    <button class="pure-button pure-button-primary" on-click="saveJob">Save</button>
    <button class="pure-button pure-button-cancel" on-click="goBack">Close</button>
  </div>
{{/with}}</div>`;

  r.on('openJob', function(ev, item) {
    if (item && !item.id && typeof item !== 'object') {
      const jobs = this.get('jobs');
      if (!this.get('jobs')) {
        this.refreshJobs().then(() => {
          this.fire('openJob', {}, item);
        });
        return;
      } else {
        item = _.find(jobs, e => e.id === item);
      }
    }

    const config = this.on('newConfig', (ev, which) => {
      if (which !== 'job') return;

      let val = ev.original.target.value;
      try {
        this.set('tmp.item.config', JSON.parse(val));
        this.set('tmp.configError', false);
      } catch (e) {
        console.log(e);
        this.set('tmp.configError', true);
      }
    });

    this.clearSelection();
    this.modal({ template: tpl, close() {
        config.cancel();
        return true;
      },
      data: {
        item: _.cloneDeep(item),
        original: item
      }
    });

    return false;
  });

  r.on('saveJob', function(ev) {
    let { item, original } = this.get('tmp');

    xhr.json.post(`${config.mount}/job`, { item }).then(i => {
      let idx = this.get('jobs').indexOf(original);
      if (~idx) this.splice('jobs', idx, 1, i);
      else this.unshift('jobs', i);
      this.unblock();
    }, e => this.message(`Job save failed:<br/>${e.message}`, { title: 'Error', class: 'error' }));
  });
}
