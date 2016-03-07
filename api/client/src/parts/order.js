export default function(r) {
  const tpl = `<div style="min-height: 80vh; min-width: 80vw;" class="pure-form flex">{{#with tmp.item}}
  <div class="title">Order - {{.name}}</div><div />
  <div class="flex primary" style="overflow: auto;">
    <div class="content flex">
      <div class="tabs"><div>
        <div class="tab{{#if ~/tmp.tab === 'details' || !~/tmp.tab}} selected{{/if}}" on-click="set('tmp.tab', 'details')">Details</div>
        <div class="tab{{#if ~/tmp.tab === 'current'}} selected{{/if}}" on-click="set('tmp.tab', 'current')">Output</div>
        <div class="tab{{#if ~/tmp.tab === 'previous'}} selected{{/if}}" on-click="set('tmp.tab', 'previous')">Previous Runs</div>
        {{#if ~/tmp.output}}<div class="tab{{#if ~/tmp.tab === 'output'}} selected{{/if}}" on-click="set('tmp.tab', 'output')">Previous Output</div>{{/if}}
      </div></div>

      {{#if ~/tmp.tab === 'details' || !~/tmp.tab}}
        <div class="flex primary">
          <div>
            <div class="actions">
              <button class="pure-button pure-button-primary" on-click="openEntry:{{.entryId}}">Open Entry</button>
              {{#if .status < 0}}<button class="pure-button pure-button-primary" on-click="holdOrder:{{.}}">Hold</button>{{/if}}
              {{#if .status >= 0 && .status !== 10}}<button class="pure-button pure-button-primary" on-click="rerunOrder:{{.}}">Re-run</button>{{/if}}
            </div>
            <label class="field">Status<input value="{{.status}}" type="number" /></label>
            <label class="field">Result<input value="{{.result}}" type="number" readonly /></label>
            <label class="check field"><input checked="{{.onDemand}}" type="checkbox" disabled /> On Demand?</label>
            <label class="field">Eligible<input value="{{.eligibleAt ? .eligibleAt : 'Nope'}}" readonly /></label>
            <label class="field">Started<input value="{{.startedAt ? .startedAt : 'Nope'}}" readonly /></label>
            <label class="field">Completed<input value="{{.completedAt ? .completedAt : 'Nope'}}" readonly /></label>
          </div>
          <div class="flex primary"><label>Steps</label><textarea class="primary" readonly>{{JSON.stringify(.steps || {}, null, '  ')}}</textarea></div>
          <div class="flex primary"><label>Config</label><textarea class="primary" readonly>{{JSON.stringify((.entry || {}).config || {}, null, '  ')}}</textarea></div>
        </div>
      {{/if}}

      {{#if ~/tmp.tab === 'current'}}
        <div class="flex primary">
          <div class="tabs"><div>
            <div class="tab{{#if ~/tmp.curOutputTab === 'sysout' || !~/tmp.curOutputTab}} selected{{/if}}" on-click="set('tmp.curOutputTab', 'sysout')">Output</div>
            <div class="tab{{#if ~/tmp.curOutputTab === 'syserr'}} selected{{/if}}" on-click="set('tmp.curOutputTab', 'syserr')">Error</div>
          </div></div>

          <div class="primary" style="height: 0px; overflow: auto;">
            <code><pre style="overflow: visible;">{{~/tmp.curOutputTab === 'syserr' ? ~/tmp.curOutput.syserr : ~/tmp.curOutput.sysout}}</pre></code>
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
    let prev = false, cur = false;
    const observer = this.observe('tmp.tab', v => {
      if (v === 'previous' && !prev) {
        prev = true;
        xhr.json.get(`${config.mount}/previous/orders/${item.entryId}`).then(xs => {
          this.set('tmp.previous', xs);
        });
      } else if (v === 'current' && !cur) {
        cur = true;
        xhr.json.get(`${config.mount}/output/${this.get('tmp.item.id')}`).then(o => {
          this.set('tmp.curOutput', o);
          this.set('tmp.curOutputTab', 'sysout');
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

  r.on('rerunOrder', function(ev, order) {
    xhr.json.post(`${config.mount}/order/on/demand`, { entry: { id: order.entryId, scheduleId: order.scheduleId } }).then(o => {
      this.message('Order scheduled to re-run on the next reload.');
    }, err => {
      this.message('Failed to re-run order.', { title: 'Error', class: 'error' });
    });
  });
}
