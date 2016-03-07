export default function(r) {
  const tpl = `<div style="min-height: 80vh; min-width: 80vw;" class="pure-form flex">{{#with tmp.item}}
    <div class="title">Command - {{.name}}</div><div />
    <div class="flex primary" style="overflow: auto;">
      <div>
        <label class="field">Name<input value="{{.name}}" /></label>
        <label class="field">Label<input value="{{.label}}" /></label>
        <label class="field">Version<input readonly value="{{.version}}" /></label>
        <label class="field check"><input type="checkbox" checkbox="{{~/tmp.newVersion}}" /> New version?</label>
      </div>

      <div class="content flex">
        <div class="tabs"><div>
          <div class="tab{{#~/tmp.tab === 'files' || !~/tmp.tab}} selected{{/if}}" on-click="set('tmp.tab', 'files')">Files</div>
          <div class="tab{{#~/tmp.tab === 'init'}} selected{{/if}}" on-click="set('tmp.tab', 'init')">Init Steps</div>
        </div></div>
        {{#if ~/tmp.tab === 'files' || !~/tmp.tab}}
          <div class="flex columns primary">
            <div class="flex container" style="min-width: 14em; font-size: 0.8em;">
              <div>
                <div class="container">
                  <button class="pure-button pure-button-secondary" on-click="push('tmp.item.files', {})">Add File</button>
                </div>
                <div class="list striped">
                  {{ensureArray('tmp.item.files') ? '' : ''}}
                  {{#each .files}}
                    <div>
                      <div class="primary file{{#if @index === ~/tmp.file}} selected{{/if}}" on-click="set('tmp.file', @index)">{{.name}}</div>
                      <button class="pure-button pure-button-cancel" on-click="splice('tmp.item.files', @index, 1)"><span class="icon">&#8855;</span></button>
                    </div>
                  {{/each}}
                </div>
              </div>
            </div>
            {{#if typeof ~/tmp.file === 'number' && ~/tmp.file < .files.length}}
              <div class="flex primary">
                {{#with .files[~/tmp.file]}}
                  <div>
                    <label class="field">Name<input value="{{.name}}" on-change="update('tmp.item.files')" /></label>
                    <label class="field">Mode<input value="{{.mode}}" /></label>
                  </div>
                  <div class="primary" style="min-height: 20em;" decorator="ace:{{ { filename: .name, keypath: @keypath + '.content' } }}">{{>'editorConfig'}}</div>
                {{/with}}
              </div>
            {{/if}}
          </div>
        {{/if}}

        {{#if ~/tmp.tab === 'init'}}
          <div>
            <p style="max-width: 80vw">
              Init commands are run in order the first time that a command version is installed on an agent. You can specify the executable name and each argument. The commands are run after all of the files from the command are in place, so it's possible to do things like specify a \`package.json\` file and run \`npm i\` to fetch dependencies.
            </p>
            <button class="pure-button pure-button-secondary" on-click="push(@keypath + '.init', { args: [] })">Add Command</button>
            <div class="list striped">
              {{ensureArray('tmp.item.init') ? '' : ''}}
              {{#each .init}}
                <div style="align-items: flex-end;">
                  <div>
                    <button {{#if @index === 0}}disabled{{/if}} class="pure-button" on-click="moveUpList()">&#8679;</button>
                    <button {{#if @index + 1 === ../length}}disabled{{/if}} class="pure-button" on-click="moveDownList()">&#8681;</button>
                    <button class="pure-button pure-button-cancel" on-click="removeFromList()"><span class="icon">&#8855;</span></button>
                  </div>
                  <div>
                    <label class="field">Command<input value="{{.cmd}}" /></label>
                  </div>
                  <div>
                    Args
                    <button class="pure-button pure-button-secondary" on-click="push(@keypath + '.args', '')">Add</button>
                  </div>
                  {{ensureArray('tmp.item.init.' + @index + '.args') ? '' : ''}}
                  {{#each .args}}
                    <div>
                      <label class="field"><div class="button-group"><button class="pure-button" on-click="moveUpList()" {{#if @index === 0}}disabled{{/if}}>&#8678;</button><button class="pure-button pure-button-cancel" on-click="removeFromList()">&#8855;</button><button class="pure-button" on-click="moveDownList()" {{#if @index + 1 === ../length}}disabled{{/if}}>&#8680;</button></div><input value="{{.}}" /></label>
                    </div>
                  {{/each}}
                </div>
              {{/each}}
            </div>
          </div>
        {{/if}}
      </div>
    </div>
    <div class="pre-buttons" />
    <div class="buttons">
      <button class="pure-button pure-button-primary" on-click="saveCommand">Save</button>
      <button class="pure-button pure-button-cancel" on-click="blockerClose">Cancel</button>
    </div>
  {{/with}}</div>`;

  r.on('openCommand', function(ev, item) {
    this.clearSelection();
    this.modal({ template: tpl, close() {
        return true;
      },
      data: { item: _.cloneDeep(item), original: item }
    });
    return false;
  });

  r.on('saveCommand', function(ev) {
    let { item, original, newVersion } = this.get('tmp');

    if (newVersion) {
      delete item.id;
      delete item.updatedAt;
      item.newVersion = true;
    }

    xhr.json.post(`${config.mount}/command`, { item }).then(i => {
      if (!newVersion) {
        let idx = this.get('commands').indexOf(original);
        if (~idx) this.splice('commands', idx, 1, i);
      } else {
        this.push('commands', i);
      }
      this.unblock();
    }, e => this.message(`Command save failed:<br/>${e.message}`, { title: 'Error', class: 'error' }));
  });
}
