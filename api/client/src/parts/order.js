export default function(r) {
  const tpl = `<div style="min-height: 80vh; min-width: 80vw;" class="pure-form flex">{{#with tmp.item}}
  <div class="title">Order - {{.name}}</div><div />
  <div class="flex primary" style="overflow: auto;">
    <div class="content flex">
      <div class="tabs"><div>
        <div class="tab{{#if ~/tmp.tab === 'details' || !~/tmp.tab}} selected{{/if}}" on-click="set('tmp.tab', 'details')">Details</div>
        <div class="tab{{#if ~/tmp.tab === 'previous'}} selected{{/if}}" on-click="set('tmp.tab', 'previous')">Previous Runs</div>
        {{#if ~/tmp.output}}<div class="tab{{#if ~/tmp.tab === 'output'}} selected{{/if}}" on-click="set('tmp.tab', 'output')">Output</div>{{/if}}
      </div></div>

      {{#if ~/tmp.tab === 'details' || !~/tmp.tab}}
        <div>
          <div class="actions">
            <button class="pure-button pure-button-primary" on-click="openEntry:{{.entryId}}">Open Entry</button>
          </div>
        </div>
      {{/if}}

      {{#if ~/tmp.tab === 'previous'}}
        <div class="list striped">
          <div class="header"><div class="l-1-6">Agent</div><div class="l-1-8">Result</div><div class="l-1-6">Status</div><div class="l-1-6">Started</div><div class="l-1-6">Completed</div><div class="l-1-6">On Demand</div></div>
          {{#each ~/tmp.previous}}
            <div on-dblclick-dbltap="openOutput:{{.}}">
              <div class="l-1-6">{{.agentId && ~/agents[~/agentMap[.agentId]] ? ~/agents[~/agentMap[.agentId]].name || '<Unknown>' : '<None>'}}</div>
              <div class="l-1-8">{{.result}}</div>
              <div class="l-1-6">
                {{#if .status < 0}}Pending
                {{elseif .status === 0}}Successful
                {{elseif .status === 10}}Running
                {{elseif .status === 1}}Failed
                {{elseif .status === 2}}Soft Fail
                {{else}}Unknown{{/if}}
              </div>
              <div class="l-1-6">{{~/filter.timestamp(.startedAt)}}</div>
              <div class="l-1-6">{{~/filter.timestamp(.completedAt)}}</div>
              <div class="l-1-6">{{.onDemand ? 'Yes' : 'No'}}</div>
            </div>
          {{else}}
            <div>No records found.</div>
          {{/each}}
        </div>
      {{/if}}

      {{#if ~/tmp.tab === 'output'}}
        <div class="flex primary">
          <div class="tabs"><div>
            <div class="tab{{#if ~/tmp.outputTab === 'sysout' || !~/tmp.outputTab}} selected{{/if}}" on-click="set('tmp.outputTab', 'sysout')">Output</div>
            <div class="tab{{#if ~/tmp.outputTab === 'syserr'}} selected{{/if}}" on-click="set('tmp.outputTab', 'syserr')">Error</div>
          </div></div>

          <div class="primary" style="height: 0px; overflow: auto;">
            <code><pre style="overflow: visible;">{{~/tmp.outputTab === 'syserr' ? ~/tmp.output.syserr : ~/tmp.output.sysout}}</pre></code>
          </div>
        </div>
      {{/if}}
    </div>
  </div>
{{/with}}</div>`;

  r.on('openOrder', function(ev, item) {
    if (item && !item.id && typeof item !== 'object') {
      xhr.json.get(`${config.mount}/order/${item}`).then(o => this.fire('openOrder', {}, o));
      return;
    }
    let prev = false;
    const observer = this.observe('tmp.tab', v => {
      if (v === 'previous' && !prev) {
        prev = true;
        xhr.json.get(`${config.mount}/previous/orders/${item.entryId}`).then(xs => {
          this.set('tmp.previous', xs);
        });
      }
    });

    const listener = r.on('openOutput', (ev, order) => {
      xhr.json.get(`${config.mount}/output/${order.id}`).then(o => {
        this.set('tmp.output', o);
        this.set('tmp.tab', 'output');
      });
    });

    this.clearSelection();
    this.modal({ template: tpl, close() {
        observer.cancel();
        listener.cancel();
        return true;
      },
      data: { item: _.cloneDeep(item), original: item }
    });
    return false;
  });
}
