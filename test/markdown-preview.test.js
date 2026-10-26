'use strict';
const assert = require('assert');
const Module = require('module');
class Emitter {
  constructor() { this.listeners = new Set(); this.event = fn => { this.listeners.add(fn); return { dispose: () => this.listeners.delete(fn) }; }; }
  fire(value) { for (const fn of this.listeners) fn(value); }
  dispose() { this.listeners.clear(); }
}
const changes = new Emitter();
const panels = [];
const legacyPreview = () => { throw new Error('旧版入口不应被调用'); };
const commands = new Map([['mindmap.markdownPreview', legacyPreview]]);
const editorTypes = new Set(['mindmap.editor']);
const notices = [];
let writes = 0;
const reads = [];
const uri = value => ({ fsPath: value, toString: () => value });
const vscode = {
  EventEmitter: Emitter, ViewColumn: { One: 1, Nine: 9 },
  Uri: { joinPath: (base, ...parts) => uri(base.fsPath + '/' + parts.join('/')) },
  workspace: { onDidChangeTextDocument: changes.event, getConfiguration: () => ({get: () => 'lightMap'}), fs: {writeFile: async () => { writes++; }, readFile: async value => { reads.push(value.fsPath); return require('fs').readFileSync(require('path').join(__dirname,'../resources/icon.png')); }} },
  commands: { registerCommand: (id, callback) => { assert.ok(!commands.has(id), '重复命令: '+id); commands.set(id, callback); return {dispose() {}}; } },
  window: {
    registerCustomEditorProvider: type => { assert.ok(!editorTypes.has(type), '重复编辑器: '+type); editorTypes.add(type); return {dispose() {}}; },
    showInformationMessage: message => notices.push(message),
    createWebviewPanel: (type, title, showOptions) => {
      const panel = { type, title, showOptions, messages: [], revealed: 0, reveal(column, preserveFocus) { this.revealed++; this.revealOptions = {column, preserveFocus}; }, onDidDispose(fn) { this.close = fn; } };
      panel.webview = {
        postMessage: message => { panel.messages.push(message); return Promise.resolve(true); },
        asWebviewUri: value => value.fsPath, cspSource: 'file:',
        onDidReceiveMessage: fn => { panel.receive = fn; return {dispose: () => { panel.receive = null; }}; },
      };
      panel.htmlWrites=0;Object.defineProperty(panel.webview,'html',{get:()=>panel.html,set:value=>{panel.html=value;panel.htmlWrites++;}});
      panels.push(panel); return panel;
    },
  },
};
const originalLoad = Module._load;
Module._load = function (name, parent, isMain) { return name === 'vscode' ? vscode : originalLoad.call(this, name, parent, isMain); };
const { activate } = require('../dist/extension');
Module._load = originalLoad;

(async () => {
  activate({ extensionUri: uri('/extension'), subscriptions: [] });
  assert.ok(commands.has('mindsprout.markdownPreview'));
  assert.ok(editorTypes.has('mindsprout.editor'));
  assert.strictEqual(commands.get('mindmap.markdownPreview'),legacyPreview);
  const command = commands.get('mindsprout.markdownPreview');
  command();
  assert.ok(notices[0].includes('Markdown'));
  let text = '# 未保存的内容\n- 第一条';
  const source = {uri: uri('/notes/demo.md'), fileName: '/notes/demo.md', languageId: 'markdown', getText: () => text};
  vscode.window.activeTextEditor = {document: source, viewColumn: 3};
  command();
  assert.strictEqual(panels.length, 1);
  const panel = panels[0];
  assert.ok(panel.title.includes('demo.md'));
  assert.deepStrictEqual(panel.showOptions, {viewColumn: 4, preserveFocus: true});
  panel.receive({type: 'ready'});
  assert.strictEqual(panel.messages[0].markdown, text);
  assert.strictEqual(panel.messages[0].readOnly, true);
  assert.strictEqual(panel.messages[0].type, 'init');
  panel.receive({type:'resolve-image',requestId:'img1',src:'resources/icon.png'});
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.ok(reads[0].includes('demo.md/../resources/icon.png'));
  assert.ok(panel.messages.at(-1).dataUri.startsWith('data:image/png;base64,'));
  assert.strictEqual(panel.messages.at(-1).requestId,'img1');
  const readCount=reads.length;
  panel.receive({type:'resolve-image',requestId:'bad',src:'javascript:alert(1)'});
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.ok(panel.messages.at(-1).error);assert.strictEqual(reads.length,readCount);
  command();
  assert.strictEqual(panels.length, 1);
  assert.strictEqual(panel.revealed, 1);
  assert.strictEqual(panel.htmlWrites,2,'重复命令重新加载失效预览，恢复初始化握手');
  vscode.window.visibleTextEditors = [vscode.window.activeTextEditor];
  vscode.window.activeTextEditor = undefined;
  command(source.uri);
  assert.strictEqual(panels.length,1);assert.strictEqual(panel.revealed,2);
  vscode.window.activeTextEditor = vscode.window.visibleTextEditors[0];
  assert.deepStrictEqual(panel.revealOptions, {column: 4, preserveFocus: true});
  const manifest = require('../package.json');
  assert.ok(manifest.contributes.menus['editor/title'].some(item=>item.command==='mindsprout.markdownPreview'&&item.group==='navigation@1'&&item.when.includes('markdown')));
  assert.ok(manifest.contributes.commands.find(item=>item.command==='mindsprout.markdownPreview').icon);
  assert.strictEqual(manifest.displayName, '思络 · ThoughtWeave');
  assert.strictEqual(manifest.contributes.configuration.title, '思络 · ThoughtWeave');
  assert.strictEqual(manifest.contributes.commands.find(c => c.command === 'mindsprout.markdownPreview').title, 'ThoughtWeave');
  for (const id of ['mindsprout.new', 'mindsprout.newInFolder']) {
    assert.ok(commands.has(id));
    assert.strictEqual(manifest.contributes.commands.find(c => c.command === id).title, 'New ThoughtWeave');
  }
  assert.ok(manifest.contributes.menus['explorer/context'].some(m => m.command === 'mindsprout.newInFolder' && m.when === 'explorerResourceIsFolder'));
  text = '# 修改后的内容';
  changes.fire({document: source});
  await new Promise(resolve => setTimeout(resolve, 240));
  assert.strictEqual(panel.messages.at(-1).markdown, text);
  const count = panel.messages.length;
  changes.fire({document: {uri: uri('/notes/other.md')}});
  await new Promise(resolve => setTimeout(resolve, 240));
  assert.strictEqual(panel.messages.length, count);
  panel.receive({type: 'save', data: {root: {text: '禁止写回'}}});
  assert.strictEqual(writes, 0);
  changes.fire({document: source});
  panel.close();
  assert.strictEqual(changes.listeners.size, 0);
  await new Promise(resolve => setTimeout(resolve, 240));
  assert.strictEqual(panel.messages.length, count);
  command();
  assert.strictEqual(panels.length, 2);
  panels[1].close();
  console.log('Markdown command, unsaved source, live updates, panel reuse, read-only protection and disposal passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
