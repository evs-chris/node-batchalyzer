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
    <button class="pure-button pure-button-cancel" on-click="blockerClose">Close</button>
  </div>
{{/with}}</div>`;

  r.on('openAgent', function(ev, item) {
    this.clearSelection();
    this.modal({ template: tpl, close() {
        return true;
      },
      data: { item: _.cloneDeep(item), original: item }
    });
    return false;
  });
}
