export default function(r) {
  const tpl = `<div style="min-height: 80vh; min-width: 80vw;" class="pure-form flex">{{#with tmp.item}}
  <div class="title">Agent - {{.name}}</div><div />
  <div class="flex primary" style="overflow: auto;">
    <div style="min-height: 15em;">
      <label class="field">Name<input value="{{.name}}" /></label>
      <label class="field">Label<input value="{{.label}}" /></label>
      <label class="field">Key<input value="{{.key}}" type="password" /></label>
      <label class="field">Location<input value="{{.location}}" ></label>
      {{#if .lastSeen}}<label class="field">Last Seen<input value="{{~/filter.timestamp(.lastSeen)}}" readonly /></label>{{/if}}
      <label class="field text">Info<textarea readonly>{{JSON.stringify(.info, null, '  ')}}</textarea></label>
    </div>
  </div>
  <div class="pre-buttons" />
  <div class="buttons">
    <button class="pure-button pure-button-primary" on-click="saveAgent">Save</button>
    <button class="pure-button pure-button-cancel" on-click="blockerClose">Close</button>
  </div>
{{/with}}</div>`;

  r.on('openAgent', function(ev, item) {
    if (item && !item.id && typeof item !== 'object') {
      const agents = this.get('agents');
      item = _.find(agents, e => e.id === item);
    }

    this.clearSelection();
    this.modal({ template: tpl, close() {
        return true;
      },
      data: { item: _.cloneDeep(item), original: item }
    });
    return false;
  });

  r.on('saveAgent', function(ev) {
    let { item, original } = this.get('tmp');

    xhr.json.post(`${config.mount}/agent`, { item }).then(i => {
      let idx = this.get('agents').indexOf(original);
      if (~idx) this.splice('agents', idx, 1, i);
      else this.unshift('agents', i);
      this.unblock();
    }, e => this.message(`Agent save failed:<br/>${e.message}`, { title: 'Error', class: 'error' }));
  });
}
