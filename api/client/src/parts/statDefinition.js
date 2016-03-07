export default function(r) {
  const tpl = `<div style="min-height: 80vh; min-width: 80vw;" class="pure-form flex">{{#with tmp.item}}
  <div class="title">Stat Definition - {{.name}}</div><div />
  <div class="flex primary" style="overflow: auto;">
    <div class="content flex">
      <div class="tabs"><div>
        <div class="tab{{#if ~/tmp.tab === 'details' || !~/tmp.tab}} selected{{/if}}" on-click="set('tmp.tab', 'details')">Details</div>
      </div></div>

      {{#if ~/tmp.tab === 'details' || !~/tmp.tab}}
        <div>
          <label class="field">Name<input value="{{.name}}" /></label>
          <label class="field">Type<select value="{{.type}}"><option>fork</option><option>shell</option><option>mem</option></select></label>
          <label class="field">Warning<input type="number" value="{{.warning}}" /></label>
          <label class="field">Critical<input type="number" value="{{.critical}}" /></label>
          {{#if .type === 'fork' || .type === 'shell'}}
            <label class="text field">Config{{#if ~/tmp.configError}} <span style="color: red; font-weight: bold;">ERROR</span>{{/if}}<textarea twoway="false" value="{{JSON.stringify(.config, null, '  ')}}" on-change="newConfig:def" /></label>
          {{/if}}
        </div>
      {{/if}}
    </div>
  </div>
  <div class="pre-buttons" />
  <div class="buttons">
    <button class="pure-button pure-button-primary" on-click="saveStatDef">Save</button>
    <button class="pure-button pure-button-cancel" on-click="blockerClose">Cancel</button>
  </div>
{{/with}}</div>`;

  r.on('openStatDef', function(ev, item) {
    if (item && !item.id && typeof item !== 'object') {
      const defs = this.get('statDefs');
      if (!this.get('statDefs')) {
        this.refreshStats().then(() => {
          this.fire('openStateDef', {}, item);
        });
        return;
      } else {
        item = _.find(defs, e => e.id === item);
      }
    }

    const config = this.on('newConfig', (ev, which) => {
      if (which !== 'def') return;

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

  r.on('saveStatDef', function(ev) {
    let { item, original } = this.get('tmp');

    xhr.json.post(`${config.mount}/stat/definition`, { item }).then(i => {
      let idx = this.get('statDefs').indexOf(original);
      if (~idx) this.splice('statDefs', idx, 1, i);
      else this.unshift('statDefs', i);
      this.unblock();
    }, e => this.message(`Stat Definition save failed:<br/>${e.message}`, { title: 'Error', class: 'error' }));
  });
}

