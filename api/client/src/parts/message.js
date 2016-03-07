export default function(r) {
  const tpl = `<div style="min-height: 80vh; min-width: 80vw;" class="pure-form flex">{{#with tmp.item}}
  <div class="title">Message - {{.message}}</div><div />
  <div class="flex primary" style="overflow: auto;">
    <div class="actions">
      {{#if .orderId}}<button class="pure-button pure-button-primary" on-click="openOrder:{{.orderId}}">View Order</button>{{/if}}
      {{#if .agentId && ~/agents[~/agentMap[.agentId]]}}<button class="pure-button pure-button-primary" on-click="openAgent:{{~/agents[~/agentMap[.agentId]]}}">View Agent</button>{{/if}}
      {{#if .status !== 1}}<button class="pure-button pure-button-primary" on-click="messageState:{{'status'}},{{+1}}">{{#if .status === 3}}Unresolve{{else}}Acknowledge{{/if}}</button>{{/if}}
      {{#if .status === 1}}<button class="pure-button pure-button-primary" on-click="messageState:{{'status'}},{{+0}}">Unacknowledge</button>{{/if}}
      {{#if .status !== 3}}<button class="pure-button pure-button-primary" on-click="messageState:{{'status'}},{{+3}}">Resolve</button>{{/if}}
    </div>
    <div style="min-height: 15em;">
      <label class="field text">Message<textarea readonly>{{.message}}</textarea></label>
      <label class="field">Status<input value="{{.status}}" readonly /></label>
      <label class="field">Priority<input value="{{.priority}}" readonly /></label>
      <label class="field">Handle<input value="{{.handle}}" readonly /></label>
      {{#if .category != null}}<label class="field">Category<input value="{{.category}}" readonly /></label>{{/if}}
      <label class="field text">Extra<textarea readonly twoway="false">{{JSON.stringify(.extra, null, '  ')}}</textarea></label>
      <label class="field text">Audit<textarea readonly twoway="false">{{JSON.stringify(.audit, null, '  ')}}</textarea></label>
    </div>
  </div>
  <div class="pre-buttons" />
  <div class="buttons">
    <button class="pure-button pure-button-cancel" on-click="goBack">Close</button>
  </div>
{{/with}}</div>`;

  r.on('openMessage', function(ev, item) {
    let where = item.status;
    const listener = r.on('messageState', (ev, what, value) => {
      item[what] = value;
      xhr.json.post(`${config.mount}/message`, { item }).then(m => {
        if (where !== m.status) {
          if (where === 3 && this.get('recentMessages')) this.splice('recentMessages', this.get('recentMessages').indexOf(item), 1);
          else this.splice('messages', this.get('messages').indexOf(item), 1);
        }
        let { key, idx } = m.status === 3 ? { key: 'recentMessages', idx: (this.get('recentMessages') || []).indexOf(item) } : { key: 'messages', idx: this.get('messages').indexOf(item) };
        this.splice(key, idx, 1, m);
        this.set('tmp.original', m);
        this.set('tmp.item', _.cloneDeep(m));
        item = m;
      });
    });

    this.clearSelection();
    this.modal({ template: tpl, close() {
        listener.cancel();
        return true;
      },
      data: { item: _.cloneDeep(item), original: item }
    });
    return false;
  });
}
