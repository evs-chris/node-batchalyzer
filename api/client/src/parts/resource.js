export default function(r) {
  const tpl = `<div style="min-height: 80vh; min-width: 80vw;" class="pure-form flex">{{#with tmp.item}}
  <div class="title">Resource - {{.name}}</div><div />
  <div class="flex primary" style="overflow: auto;">
    <div class="content flex">
      <div class="tabs"><div>
        <div class="tab{{#if ~/tmp.tab === 'details' || !~/tmp.tab}} selected{{/if}}" on-click="set('tmp.tab', 'details')">Details</div>
      </div></div>

      {{#if ~/tmp.tab === 'details' || !~/tmp.tab}}
        <div>
          <label class="field">Name<input value="{{.name}}" /></label>
          <label class="field">Type<select value="{{.type}}"><option value="{{+0}}">Pool</option><option value="{{+1}}">Rate</option></select></label>
          {{#if .type === 0}}
            <label class="field">Total<input value="{{.total}}" type="number" /></label>
            <label class="field">Total<input value="{{.used}}" type="number" /></label>
          {{else}}
            <label class="field">Max/Minute<input value="{{.maxPerMinute}}" type="number" /></label>
          {{/if}}
        </div>
      {{/if}}
    </div>
  </div>
  <div class="pre-buttons" />
  <div class="buttons">
    <button class="pure-button pure-button-primary" on-click="saveResource">Save</button>
    <button class="pure-button pure-button-cancel" on-click="goBack">Close</button>
  </div>
{{/with}}</div>`;

  r.on('openResource', function(ev, item) {
    if (item && !item.id && typeof item !== 'object') {
      const resources = this.get('resources');
      item = _.find(resources, e => e.id === item);
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

  r.on('saveResource', function(ev) {
    let { item, original } = this.get('tmp');

    xhr.json.post(`${config.mount}/resource`, { item }).then(i => {
      let idx = this.get('resources').indexOf(original);
      if (~idx) this.splice('resources', idx, 1, i);
      else this.unshift('resources', i);
      this.unblock();
    }, e => this.message(`Resource save failed:<br/>${e.message}`, { title: 'Error', class: 'error' }));
  });
}
