export default function(r) {
  const tpl = `<div style="min-height: 80vh; min-width: 80vw;" class="pure-form flex">{{#with tmp.item}}
  <div class="title">Entry - {{~/orderName(.)}}</div><div />
  <div class="flex primary" style="overflow: auto;">
    <div class="actions">
      <button class="pure-button pure-button-primary" on-click="runEntryNow:{{.}}">Schedule Now</button>
      {{#if .jobId}}<button class="pure-button pure-button-primary" on-click="openJob:{{.jobId}}">Open Job</button>{{/if}}
    </div>
    <div class="content flex">
      <div class="tabs"><div>
        <div class="tab{{#if ~/tmp.tab === 'details' || !~/tmp.tab}} selected{{/if}}" on-click="set('tmp.tab', 'details')">Details</div>
        <div class="tab{{#if ~/tmp.tab === 'schedule'}} selected{{/if}}" on-click="set('tmp.tab', 'schedule')">Schedule</div>
      </div></div>

      {{#if ~/tmp.tab === 'details' || !~/tmp.tab}}
        <div>
          Details
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
    <button class="pure-button pure-button-primary" on-click="saveEntry">Save</button>
    <button class="pure-button pure-button-cancel" on-click="blockerClose">Cancel</button>
  </div>
{{/with}}</div>`;

  r.on('openEntry', function(ev, item) {
    if (item && !item.id && typeof item !== 'object') {
      const entries = this.get('entries');
      if (!this.get('entries')) {
        this.refreshEntries().then(() => {
          this.fire('openEntry', {}, item);
        });
        return;
      } else {
        item = _.find(entries, e => e.id === item);
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

  r.on('runEntryNow', (ev, entry) => {
    xhr.json.post(`${config.mount}/order/on/demand`, entry).then(o => {
      this.message('Entry scheduled to run on the next reload.');
    }, err => {
      this.message('Failed to schedule entry.', { title: 'Error', class: 'error' });
    });
  });

  r.on('saveEntry', function() {
    let { item, original } = this.get('tmp');

    xhr.json.post(`${config.mount}/entry`, { item }).then(i => {
      this.splice('entries', this.get('entries').indexOf(original), 1, i);
      this.unblock();
    }, e => this.message(`Command saved failed:<br/>${e.message}`, { title: 'Error', class: 'error' }));
  });
}

