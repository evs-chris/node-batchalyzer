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
        <div>
          <textarea readonly style="width: 100%; height: 20em;">{{JSON.stringify(.config, null, '  ')}}</textarea>
        </div>
      {{/if}}

      {{#if ~/tmp.tab === 'schedule'}}
        <div>
          <Schedule schedule="{{.schedule}}"/>
        </div>
      {{/if}}
    </div>
  </div>
{{/with}}</div>`;

  r.on('openJob', function(ev, item) {
    if (item && !item.id && typeof item !== 'object') {
      const jobs = this.get('jobs');
      if (!this.get('jobs')) {
        this.refreshJobS().then(() => {
          this.fire('openJob', {}, item);
        });
        return;
      } else {
        item = _.find(jobs, e => e.id === item);
      }
    }

    this.clearSelection();
    this.modal({ template: tpl, close() {
        return true;
      },
      data: {
        item: _.cloneDeep(item),
        original: item
      }
    });

    return false;
  });
}
