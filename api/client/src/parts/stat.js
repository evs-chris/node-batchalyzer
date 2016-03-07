export default function(r) {
  const tpl = `<div style="min-height: 80vh; min-width: 80vw;" class="pure-form flex">{{#with tmp.item}}
  <div class="title">Stat - {{.id}}</div><div />
  <div class="flex primary" style="overflow: auto;">
    <div class="content flex">
      <div class="actions">
        {{#if .agentId}}<button class="pure-button pure-button-primary" on-click="openAgent:{{.agentId}}">Open Agent</button>{{/if}}
        {{#if .definitionId}}<button class="pure-button pure-button-primary" on-click="openStatDef:{{.definitionId}}">Open Defiinition</button>{{/if}}
      </div>
      <div class="tabs"><div>
        <div class="tab{{#if ~/tmp.tab === 'details' || !~/tmp.tab}} selected{{/if}}" on-click="set('tmp.tab', 'details')">Details</div>
      </div></div>

      {{#if ~/tmp.tab === 'details' || !~/tmp.tab}}
        <div>
          <label class="field">Agent<select value="{{.agentId}}">{{#each ~/agents}}<option value="{{.id}}">{{.label || .name}}</option>{{/each}}</label>
          <label class="field">Definition<select value="{{.definitionId}}">{{#each ~/statDefs}}<option value="{{.id}}">{{.name}}</option>{{/each}}</label>
        </div>
          <label class="text field">Config{{#if ~/tmp.configError}} <span style="color: red; font-weight: bold;">ERROR</span>{{/if}}<textarea twoway="false" value="{{JSON.stringify(.config, null, '  ')}}" on-change="newConfig:stat" /></label>
      {{/if}}
    </div>
  </div>
  <div class="pre-buttons" />
  <div class="buttons">
    <button class="pure-button pure-button-primary" on-click="saveStat">Save</button>
    <button class="pure-button pure-button-cancel" on-click="blockerClose">Cancel</button>
  </div>
{{/with}}</div>`;

  r.on('openStat', function(ev, item) {
    if (item && !item.id && typeof item !== 'object') {
      const stats = this.get('stats');
      if (!this.get('stats')) {
        this.refreshStats().then(() => {
          this.fire('openStat', {}, item);
        });
        return;
      } else {
        item = _.find(stats, e => e.id === item);
      }
    }

    const config = this.on('newConfig', (ev, which) => {
      if (which !== 'stat') return;

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

  r.on('saveStat', function(ev) {
    let { item, original } = this.get('tmp');

    xhr.json.post(`${config.mount}/stat`, { item }).then(i => {
      let idx = this.get('stats').indexOf(original);
      if (~idx) this.splice('stats', idx, 1, i);
      else this.unshift('stats', i);
      this.unblock();
    }, e => this.message(`Stat save failed:<br/>${e.message}`, { title: 'Error', class: 'error' }));
  });
}

