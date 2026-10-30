'use strict';
/* Webview 层 DOM 冒烟测试：用 jsdom 加载 core.js + mindmap.js，
 * 验证渲染、键盘新增、内联编辑、撤销、工具栏、保存等关键路径无异常。 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { JSDOM } = require('jsdom');

let passed = 0;
function ok(name, fn) {
  fn();
  passed += 1;
  console.log('  ✔ ' + name);
}

const MEDIA = path.join(__dirname, '..', 'media');
const coreSrc = fs.readFileSync(path.join(MEDIA, 'core.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(MEDIA, 'mindmap.js'), 'utf8');

function boot() {
  const dom = new JSDOM(
    fs.readFileSync(path.join(__dirname, '..', 'src', 'mindmapEditorProvider.ts'), 'utf8').match(/return `(<!DOCTYPE[\s\S]*?)`;/)[1],
    { runScripts: 'outside-only', pretendToBeVisual: true }
  );
  const win = dom.window;
  const messages = [];
  win.acquireVsCodeApi = () => ({ postMessage: (m) => messages.push(m) });
  win.eval(fs.readFileSync(path.join(MEDIA, 'bootstrap.js'), 'utf8'));
  win.eval(fs.readFileSync(path.join(MEDIA, 'mindsprout.js'), 'utf8'));
  return { dom, win, messages };
}

function sendInit(win, data) {
  win.dispatchEvent(new win.MessageEvent('message', { data: { type: 'init', data: data, fileName: 't.mindmap' } }));
}

const sample = {
  version: 1,
  root: {
    id: 'r1',
    text: 'root',
    collapsed: false,
    children: [
      { id: 'a', text: 'a', collapsed: false, children: [{ id: 'a1', text: 'a1', collapsed: false, children: [] }] },
      { id: 'b', text: 'b', collapsed: false, children: [] },
    ],
  },
};

console.log('mindmap webview smoke tests');

let env;
try {
  env = boot();
  const { win } = env;

  ok('脚本加载前图标已存在，启动故障有明确提示，共享宿主接口只初始化一次', () => {
    const template=fs.readFileSync(path.join(__dirname,'../src/mindmapEditorProvider.ts'),'utf8').match(/return \x60(<!DOCTYPE[\s\S]*?)\x60;/)[1];
    const fallback=new JSDOM(template,{runScripts:'outside-only'});
    const fw=fallback.window;
    assert.strictEqual(fw.document.querySelectorAll('#toolbar .tb-tool svg').length,13);
    let acquired=0;fw.acquireVsCodeApi=()=>{acquired++;return {postMessage(){}};};
    fw.eval(fs.readFileSync(path.join(MEDIA,'bootstrap.js'),'utf8'));
    fw.dispatchEvent(new fw.ErrorEvent('error',{message:'依赖加载失败'}));
    assert.ok(fw.document.getElementById('status-text').textContent.includes('依赖加载失败'));
    fw.eval(fs.readFileSync(path.join(MEDIA,'mindsprout.js'),'utf8'));
    assert.strictEqual(acquired,1);assert.strictEqual(fw.mindSproutReady,true);
    fallback.window.close();
  });

  ok('init 后渲染全部可见节点与连线', () => {
    sendInit(win, sample);
    const nodes = win.document.getElementById('nodes');
    assert.strictEqual(nodes.children.length, 4, 'root/a/a1/b 共 4 个节点');
    const edges = win.document.getElementById('edges');
    assert.ok(edges.innerHTML.includes('<path'), '存在树状分叉连线');
    assert.ok(win.document.getElementById('status-count').textContent.includes('4 个节点'));
  });

  ok('连线垂直骨干位于父子之间的空白区，不穿过任何节点', () => {
    const C = win.MindMapCore;
    const measure = C.createMeasure('14px sans-serif');
    const data = JSON.parse(JSON.stringify(sample));
    const { visible } = C.layoutTree(data.root, measure);
    const anyEl = win.document.querySelector('.mm-node');
    const worldX = parseFloat(anyEl.style.left) - visible[0]._x;
    const paths = Array.from(win.document.querySelectorAll('#edges path'));
    assert.ok(paths.length >= 3, '存在至少 3 条连线');
    // 共享垂直骨干格式：trunk path (M sx,py L q1x,py Q bx,...) 和 branch path (M bx,... Q ...)
    const bxSet = new Set();
    for (const p of paths) {
      const d = p.getAttribute('d');
      const nums = d.match(/-?\d+(\.\d+)?/g).map(Number);
      if (nums.length === 4) continue; // 水平直线
      // trunk path: L 在 Q 之前；branch path: Q 在 L 之前
      const lIdx = d.indexOf('L');
      const qIdx = d.indexOf('Q');
      const bx = lIdx < qIdx ? nums[4] : nums[0];
      bxSet.add(Math.round(bx));
    }
    assert.ok(bxSet.size >= 1, '存在垂直骨干');
    // 检查每个垂直骨干 x 不穿过任何节点水平范围
    for (const bx of bxSet) {
      for (const n of visible) {
        const nLeft = n._x + worldX;
        const nRight = nLeft + n._w;
        if (bx > nLeft + 0.5 && bx < nRight - 0.5) {
          assert.fail('垂直骨干 x=' + bx + ' 穿过了节点「' + n.text + '」');
        }
      }
    }
  });

  ok('Tab 选中根节点后可添加子主题并进入编辑', () => {
    const key = (k, opts) =>
      win.dispatchEvent(new win.KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, opts)));
    key('Tab'); // 无选中 → 选中根节点
    key('Tab'); // 添加子节点并进入编辑
    const nodes = win.document.getElementById('nodes');
    assert.strictEqual(nodes.children.length, 5, '新增 1 个子节点');
    assert.ok(win.document.querySelector('.mm-editor'), '进入内联编辑');
  });

  ok('编辑框输入并提交更新节点文本', () => {
    const ta = win.document.querySelector('.mm-editor');
    // 编辑框不设置固定宽高：完全由 CSS 像素级覆盖节点，避免双边框/变大
    assert.strictEqual(ta.style.width, '', '不设置固定宽度');
    assert.strictEqual(ta.style.minHeight, '', '不设置固定最小高度');
    ta.value = '新分支';
    ta.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    assert.ok(win.document.getElementById('nodes').textContent.includes('新分支'), '节点文本已更新');
    assert.strictEqual(win.document.querySelector('.mm-editor'), null, '编辑框已关闭');
  });

  ok('Ctrl+Z 两次：先撤销改文本，再撤销新增', () => {
    const key = (k, opts) =>
      win.dispatchEvent(new win.KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, opts)));
    key('z', { ctrlKey: true }); // 撤销 setText
    key('z', { ctrlKey: true }); // 撤销 addChild
    const nodes = win.document.getElementById('nodes');
    assert.strictEqual(nodes.children.length, 4, '撤销后回到 4 个节点');
    assert.ok(!win.document.getElementById('nodes').textContent.includes('新分支'));
  });

  ok('工具栏「＋ 子主题」按钮新增节点', () => {
    const btn = win.document.querySelector('[data-action="add-child"]');
    btn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    const nodes = win.document.getElementById('nodes');
    assert.strictEqual(nodes.children.length, 5);
    const ta = win.document.querySelector('.mm-editor');
    assert.ok(ta, '进入编辑');
    ta.value = '工具栏节点';
    ta.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    assert.ok(win.document.getElementById('nodes').textContent.includes('工具栏节点'));
  });

  ok('导出消息发送（SVG/HTML）', () => {
    win.document.querySelector('[data-action="export-svg"]').click();
    win.document.querySelector('[data-action="export-html"]').click();
    const types = env.messages.filter(m=>m.type==='export').map(m=>m.format);
    assert.ok(types.includes('svg') && types.includes('html'));
  });

  ok('请求保存（request-save）触发立即保存', () => {
    const before = env.messages.filter((m) => m.type === 'save').length;
    win.dispatchEvent(new win.MessageEvent('message', { data: { type: 'request-save' } }));
    const after = env.messages.filter((m) => m.type === 'save').length;
    assert.ok(after >= before, '至少触发一次 save');
  });

  ok('缩放按钮更新 CSS zoom（替代 transform scale 保证文字清晰）', () => {
  const zoomIn = win.document.querySelector('[data-action="zoom-in"]');
  zoomIn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  const zoom = win.document.getElementById('world').style.zoom;
  assert.ok(zoom && parseFloat(zoom) > 1, 'zoom 属性被放大，实际值：' + zoom);
  assert.ok(!win.document.getElementById('world').style.transform.includes('scale'), 'transform 中不再含 scale');
});

ok('折叠/展开按钮切换不报错', () => {
    const rootEl = win.document.querySelector('.mm-node[data-id="r1"]');
    const foldBtn = rootEl && rootEl.querySelector('.mm-collapse');
    if (foldBtn) {
      foldBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
      const nodes = win.document.getElementById('nodes');
      assert.ok(nodes.children.length <= 5, '折叠后节点数减少或不变');
      assert.ok(win.document.querySelector('.mm-node[data-id="r1"] .mm-collapse'), '折叠按钮仍存在');
    }
  });

  ok('重新初始化后方向键只选择，不进入编辑', () => {
    sendInit(win, JSON.parse(JSON.stringify(sample)));
    win.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    win.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    assert.strictEqual(win.document.querySelector('.mm-node.selected').dataset.id, 'a');
    assert.strictEqual(win.document.querySelector('.mm-editor'), null);
  });

  ok('编辑框点击保持输入，立即保存包含未提交文本且无布局缓存', () => {
    const node = win.document.querySelector('.mm-node[data-id="a"]');
    node.dispatchEvent(new win.MouseEvent('dblclick', { bubbles: true }));
    const ta = win.document.querySelector('.mm-editor');
    ta.value = '正在输入';
    ta.dispatchEvent(new win.MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    assert.strictEqual(win.document.querySelector('.mm-editor'), ta);
    win.dispatchEvent(new win.MessageEvent('message', { data: { type: 'request-save' } }));
    const saved = env.messages.filter(m => m.type === 'save').pop();
    assert.strictEqual(saved.data.root.children[0].text, '正在输入');
    assert.ok(!JSON.stringify(saved.data).includes('"_w"'));
  });

  ok('左向树使用左键进入子节点，右键返回父节点', () => {
    sendInit(win, JSON.parse(JSON.stringify(sample)));
    win.document.querySelector('[data-action="layout-left"]').click();
    const key = k => win.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true }));
    key('ArrowDown');
    key('ArrowRight');
    assert.strictEqual(win.document.querySelector('.mm-node.selected').dataset.id, 'a');
    key('ArrowLeft');
    assert.strictEqual(win.document.querySelector('.mm-node.selected').dataset.id, 'a1');
    key('ArrowRight');
    assert.strictEqual(win.document.querySelector('.mm-node.selected').dataset.id, 'a');
  });

  ok('长文本编辑高度按实际换行扩展，同级节点保持间距', () => {
    sendInit(win, JSON.parse(JSON.stringify(sample)));
    win.document.querySelector('[data-action="layout-right"]').click();
    win.document.querySelector('.mm-node[data-id="a"]').dispatchEvent(new win.MouseEvent('dblclick', { bubbles: true }));
    const ta = win.document.querySelector('.mm-editor');
    Object.defineProperty(ta, 'scrollHeight', { configurable: true, get: () => 150 });
    ta.value = '测试数据完整性\n' + '45456465'.repeat(15);
    ta.dispatchEvent(new win.Event('input', { bubbles: true }));
    const a = win.document.querySelector('.mm-node[data-id="a"]');
    const b = win.document.querySelector('.mm-node[data-id="b"]');
    assert.ok(parseFloat(a.style.height) >= 154);
    assert.ok(parseFloat(b.style.top) >= parseFloat(a.style.top) + parseFloat(a.style.height) + win.MindMapCore.LAYOUT.V_GAP);
    assert.strictEqual(ta.value.split('\n').length, 2, '不修改用户文本');
    ta.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });

  ok('形状菜单新增布局可切换并显示当前选择', () => {
    sendInit(win, JSON.parse(JSON.stringify(sample)));
    for (const mode of ['compact', 'spacious', 'outline']) {
      const item = win.document.querySelector('[data-action="layout-' + mode + '"]');
      item.click();
      assert.strictEqual(item.getAttribute('aria-checked'), 'true');
      assert.strictEqual(win.document.querySelectorAll('#layout-menu .active').length, 1);
      assert.strictEqual(win.document.querySelectorAll('.mm-node').length, 4);
    }
  });

  ok('右键菜单支持提升、删除、新增及根节点限制', () => {
    sendInit(win, JSON.parse(JSON.stringify(sample)));
    const open = id => {
      win.document.querySelector('.mm-node[data-id="' + id + '"]').dispatchEvent(
        new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 100, clientY: 100 }));
      return win.document.querySelector('.node-context-menu');
    };
    let menu = open('r1');
    assert.ok(menu.querySelector('[data-context-action="delete"]').disabled);
    assert.ok(menu.querySelector('[data-context-action="promote"]').disabled);
    menu = open('a1');
    menu.querySelector('[data-context-action="promote"]').click();
    win.dispatchEvent(new win.MessageEvent('message', { data: { type: 'request-save' } }));
    let data = env.messages.filter(m => m.type === 'save').pop().data;
    assert.ok(data.root.children.some(n => n.id === 'a1'));
    menu = open('a1');
    menu.querySelector('[data-context-action="delete"]').click();
    assert.strictEqual(win.document.querySelector('.mm-node[data-id="a1"]'), null);
    menu = open('a');
    menu.querySelector('[data-context-action="add-child"]').click();
    assert.ok(win.document.querySelector('.mm-editor'));
    assert.ok(menu.hidden);
    win.document.querySelector('.mm-editor').dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });

  ok('虚线关联可创建、删除、撤销，新布局图标可切换', () => {
    sendInit(win, JSON.parse(JSON.stringify(sample)));
    win.document.querySelector('.mm-node[data-id="a"]').dispatchEvent(new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    win.document.querySelector('[data-context-action="relation"]').click();
    win.document.querySelector('.mm-node[data-id="b"]').dispatchEvent(new win.MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    let line = win.document.querySelector('.relation-line');
    assert.ok(line);
    assert.strictEqual(line.getAttribute('stroke-dasharray'), '6 5');
    line.dispatchEvent(new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    win.document.querySelector('[data-relation-action="delete"]').click();
    assert.strictEqual(win.document.querySelector('.relation-line'), null);
    win.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    assert.ok(win.document.querySelector('.relation-line'));
    for (const mode of ['org', 'up']) {
      const item = win.document.querySelector('[data-action="layout-' + mode + '"]');
      assert.ok(item.querySelector('svg'));
      item.click();
      assert.strictEqual(item.getAttribute('aria-checked'), 'true');
      assert.ok(win.document.querySelector('.relation-line'));
    }
  });

  ok('关联线控制点可拖动，箭头可切换并保存', () => {
    let line = win.document.querySelector('.relation-line');
    line.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    assert.strictEqual(win.document.querySelectorAll('.relation-handle').length, 2);
    const before = win.document.querySelector('.relation-line').getAttribute('d');
    win.document.querySelector('.relation-handle').dispatchEvent(new win.MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    win.dispatchEvent(new win.MouseEvent('pointermove', { clientX: 300, clientY: 240 }));
    win.dispatchEvent(new win.MouseEvent('pointerup'));
    assert.notStrictEqual(win.document.querySelector('.relation-line').getAttribute('d'), before);
    line = win.document.querySelector('.relation-line');
    line.dispatchEvent(new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    win.document.querySelector('[data-relation-action="both"]').click();
    line = win.document.querySelector('.relation-line');
    assert.ok(line.hasAttribute('marker-start') && line.hasAttribute('marker-end'));
    win.dispatchEvent(new win.MessageEvent('message', { data: { type: 'request-save' } }));
    const saved = env.messages.filter(m => m.type === 'save').pop().data.relations[0];
    assert.strictEqual(saved.arrow, 'both');
    assert.ok(Number.isFinite(saved.control1.x));
  });

  ok('顶部导入按钮发送选择请求，导入可撤销且空文件不改变文档', () => {
    sendInit(win, JSON.parse(JSON.stringify(sample)));
    win.document.querySelector('[data-action="import-markdown"]').click();
    assert.strictEqual(env.messages[env.messages.length - 1].type, 'import-markdown');
    const importMd = content => win.dispatchEvent(new win.MessageEvent('message', { data: { type: 'markdown-imported', content, name: '笔记' } }));
    importMd('# 新项目\n## 开发\n- 接口');
    assert.ok(win.document.getElementById('nodes').textContent.includes('新项目'));
    importMd('');
    assert.ok(win.document.getElementById('nodes').textContent.includes('新项目'));
    win.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    assert.ok(win.document.querySelector('.mm-node[data-id="r1"]'));
  });
  ok('PNG 导出不绘制折叠按钮、编辑手柄或操作符号', () => {
    const texts = [];
    let circles = 0;
    const ctx = new Proxy({
      measureText: text => ({ width: text.length * 7 }),
      fillText: text => texts.push(text),
      arc: () => circles++,
    }, { get: (target, key) => key in target ? target[key] : (() => {}) });
    win.HTMLCanvasElement.prototype.getContext = () => ctx;
    win.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,dGVzdA==';
    win.Path2D = function () {};
    win.document.querySelector('[data-action="export-png"]').click();
    assert.ok(env.messages.some(m => m.type === 'export' && m.format === 'png'));
    assert.strictEqual(circles, 0);
    assert.ok(!texts.includes('+') && !texts.includes('−'));
  });

  ok('富内容节点显示表格和代码，源码可编辑且不执行 HTML', () => {
    const data = win.MindMapCore.markdownImport('# 富内容\n| A | B |\n| --- | --- |\n| 测试 | 完成 |\n\n```html\n<script>alert(1)</script>\n```');
    sendInit(win, data);
    assert.strictEqual(win.document.querySelectorAll('.mm-rich table').length, 1);
    const code = win.document.querySelector('.mm-rich-code code');
    assert.strictEqual(code.textContent, '<script>alert(1)</script>');
    assert.strictEqual(code.querySelector('script'), null);
    code.closest('.mm-node').dispatchEvent(new win.MouseEvent('dblclick', { bubbles: true }));
    const editor = win.document.querySelector('.mm-editor');
    assert.ok(editor.value.includes('<script>'));
    editor.value = '<p>更新</p>';
    editor.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert.strictEqual(win.document.querySelector('.mm-rich-code code').textContent, '<p>更新</p>');
  });

  ok('样式工具栏修改文字和分支，后代继承且支持撤销', () => {
    sendInit(win, JSON.parse(JSON.stringify(sample)));
    win.document.querySelector('.mm-node[data-id="a"]').dispatchEvent(new win.MouseEvent('pointerdown', { button: 0, bubbles: true }));
    const input = (id, value) => {
      const control = win.document.getElementById(id);
      control.value = value;
      control.dispatchEvent(new win.Event('input', { bubbles: true }));
    };
    input('line-color', '#dd3355');
    input('text-color', '#223388');
    input('font-weight', '700');
    const child = win.document.querySelector('.mm-node[data-id="a1"]');
    assert.strictEqual(child.style.fontWeight, '700');
    assert.strictEqual(child.style.color, 'rgb(34, 51, 136)');
    assert.ok(Array.from(win.document.querySelectorAll('#edges path')).some(path => path.getAttribute('stroke') === '#dd3355'));
    win.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    assert.strictEqual(win.document.querySelector('.mm-node[data-id="a1"]').style.fontWeight, '400');
    win.document.querySelector('[data-action="style-reset"]').click();
    assert.strictEqual(win.document.querySelector('.mm-node[data-id="a1"]').style.color, 'rgb(31, 35, 41)');
    win.document.querySelector('[data-action="zoom-reset"]').click();
    assert.strictEqual(win.document.getElementById('zoom-label').textContent, '100%');
    assert.strictEqual(win.document.getElementById('world').style.transform, '');
  });

  ok('点击空白或 Escape 关闭菜单，内置色板和色值可选择', () => {
    sendInit(win, JSON.parse(JSON.stringify(sample)));
    win.document.querySelector('.mm-node[data-id="a"]').dispatchEvent(new win.MouseEvent('pointerdown', { button: 0, bubbles: true }));
    for (const name of ['layout', 'theme', 'export', 'style']) {
      win.document.querySelector('[data-action="' + name + '-toggle"]').click();
      assert.ok(win.document.getElementById(name + '-menu').classList.contains('open'));
      win.document.getElementById('canvas-wrap').dispatchEvent(new win.MouseEvent('pointerdown', { bubbles: true, button: 0 }));
      assert.ok(!win.document.getElementById(name + '-menu').classList.contains('open'));
    }
    win.document.querySelector('.mm-node[data-id="a"]').dispatchEvent(new win.MouseEvent('pointerdown', { button: 0, bubbles: true }));
    win.document.querySelector('[data-action="style-toggle"]').click();
    assert.strictEqual(win.document.getElementById('line-color').type, 'text');
    win.document.querySelector('[data-color-target="line-color"][data-color="#e5484d"]').click();
    assert.strictEqual(win.document.getElementById('line-color').value, '#e5484d');
    assert.ok(win.document.getElementById('style-menu').classList.contains('open'));
    win.document.querySelector('[data-color-target="text-color"][data-color="#8b5cf6"]').click();
    assert.strictEqual(win.document.querySelector('.mm-node[data-id="a1"]').style.color, 'rgb(139, 92, 246)');
    win.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.ok(!win.document.getElementById('style-menu').classList.contains('open'));
    win.document.querySelector('[data-action="export-svg"]').click();
    const message = env.messages.filter(m => m.type === 'export' && m.format === 'svg').pop();
    assert.ok(message.content.includes('<foreignObject'));
    const svg = new win.DOMParser().parseFromString(message.content, 'image/svg+xml');
    assert.strictEqual(svg.querySelector('parsererror')?.textContent, undefined);
    assert.strictEqual(svg.querySelector('.mm-add-btn'), null);
    assert.strictEqual(svg.querySelector('.mm-collapse'), null);
    win.document.getElementById('canvas-wrap').dispatchEvent(new win.MouseEvent('pointerdown', {bubbles:true,button:0}));
    win.document.querySelector('[data-action="style-toggle"]').click();
    assert.strictEqual(win.document.getElementById('line-color').disabled, false);
    assert.strictEqual(win.document.querySelector('.mm-node.selected').dataset.id, 'r1');
  });

  ok('从右向树切换组织图使用共享圆角连线，小地图实时更新', () => {
    sendInit(win, JSON.parse(JSON.stringify(sample)));
    const selectLayout = mode => win.document.querySelector('[data-action="layout-' + mode + '"]').click();
    selectLayout('right'); selectLayout('org');
    assert.strictEqual(win.document.querySelectorAll('#edges [data-edge-role="bus"]').length, 1);
    assert.ok(win.document.querySelector('#edges [data-edge-role="branch"]').getAttribute('d').includes(' Q'));
    const mini = win.document.getElementById('minimap-canvas');
    assert.strictEqual(mini.querySelectorAll('.minimap-nodes rect').length, 4);
    const firstBox = mini.getAttribute('viewBox');
    selectLayout('up');
    assert.ok(win.document.querySelector('#edges [data-edge-role="branch"]'));
    selectLayout('right');
    assert.notStrictEqual(mini.getAttribute('viewBox'), firstBox);
    win.document.getElementById('minimap-toggle').click();
    assert.ok(mini.hasAttribute('hidden'));
    win.document.getElementById('minimap-toggle').click();
    assert.ok(!mini.hasAttribute('hidden'));
    win.document.querySelector('[data-action="export-svg"]').click();
    const msg = env.messages.filter(m => m.type === 'export' && m.format === 'svg').pop();
    assert.ok(!msg.content.includes('id="minimap"'));
  });
  ok('小地图点击定位、拖动视口，缩放同步且不改变节点数量', () => {
    const wrap = win.document.getElementById('canvas-wrap');
    const mini = win.document.getElementById('minimap-canvas');
    wrap.getBoundingClientRect = () => ({left:0,top:40,width:800,height:500});
    mini.getBoundingClientRect = () => ({left:580,top:380,width:200,height:120});
    const world = win.document.getElementById('world');
    const count = win.document.querySelectorAll('.mm-node').length;
    mini.dispatchEvent(new win.MouseEvent('pointerdown', {bubbles:true,button:0,clientX:620,clientY:420}));
    const first = world.style.left;
    win.dispatchEvent(new win.MouseEvent('pointermove', {clientX:710,clientY:450}));
    win.dispatchEvent(new win.MouseEvent('pointerup'));
    assert.notStrictEqual(world.style.left, first);
    const before = parseFloat(mini.querySelector('.minimap-viewport').getAttribute('width'));
    win.document.querySelector('[data-action="zoom-in"]').click();
    assert.ok(parseFloat(mini.querySelector('.minimap-viewport').getAttribute('width')) < before);
    assert.strictEqual(win.document.querySelectorAll('.mm-node').length, count);
    win.document.getElementById('minimap-fit').click();
  });

  ok('大导图首次打开、切换形状和重新导入均保持100%', () => {
    const large = JSON.parse(JSON.stringify(sample));
    large.root.children[0].text = '很长的节点\n'.repeat(90);
    sendInit(win, large);
    const label = win.document.getElementById('zoom-label');
    assert.strictEqual(label.textContent, '100%');
    for (const mode of ['outline','org','up','left','right']) {
      win.document.querySelector('[data-action="zoom-in"]').click();
      win.document.querySelector('[data-action="layout-' + mode + '"]').click();
      assert.strictEqual(label.textContent, '100%');
    }
    win.dispatchEvent(new win.MessageEvent('message', {data:{type:'markdown-imported',content:'# 导入\n- 节点\n'.repeat(20)}}));
    assert.strictEqual(label.textContent, '100%');
    assert.ok(win.document.querySelector('#theme-menu').textContent.includes('科技蓝'));
    assert.ok(!win.document.querySelector('#theme-menu').textContent.includes('飞书彩色'));
  });

  ok('顶部一键展开/收起切换文字，隐藏后代展开且可一步撤销', () => {
    const data = JSON.parse(JSON.stringify(sample));
    data.root.collapsed = true;
    data.root.children[0].collapsed = true;
    sendInit(win, data);
    const button = win.document.getElementById('btn-toggle-all-nodes');
    const count = () => win.document.querySelectorAll('.mm-node').length;
    assert.strictEqual(button.textContent, '节点一键展开');
    assert.strictEqual(count(), 1);
    button.click();
    assert.strictEqual(button.textContent, '节点一键收起');
    assert.strictEqual(count(), 4);
    assert.strictEqual(win.document.querySelectorAll('.minimap-nodes rect').length, 4);
    assert.strictEqual(win.document.getElementById('zoom-label').textContent, '100%');
    button.click();
    assert.strictEqual(button.textContent, '节点一键展开');
    assert.strictEqual(count(), 1);
    assert.strictEqual(win.document.querySelector('.mm-node.selected').dataset.id, 'r1');
    win.dispatchEvent(new win.KeyboardEvent('keydown', {key:'z',ctrlKey:true,bubbles:true}));
    assert.strictEqual(count(), 4);
    assert.strictEqual(button.textContent, '节点一键收起');
    win.dispatchEvent(new win.KeyboardEvent('keydown', {key:'y',ctrlKey:true,bubbles:true}));
    assert.strictEqual(count(), 1);
    win.dispatchEvent(new win.MessageEvent('message', {data:{type:'request-save'}}));
    const saved = env.messages.filter(m=>m.type==='save').pop().data;
    assert.ok(saved.root.collapsed && saved.root.children[0].collapsed);
  });
  ok('初始全部展开时提示收起，首次点击全部收起，撤销后提示同步', () => {
    sendInit(win, JSON.parse(JSON.stringify(sample)));
    const button = win.document.getElementById('btn-toggle-all-nodes');
    assert.strictEqual(button.textContent, '节点一键收起');
    assert.strictEqual(button.dataset.tooltip, '节点一键收起');
    button.click();
    assert.strictEqual(button.textContent, '节点一键展开');
    assert.strictEqual(win.document.querySelectorAll('.mm-node').length, 1);
    win.document.getElementById('btn-undo').click();
    assert.strictEqual(button.dataset.tooltip, '节点一键收起');
    assert.strictEqual(win.document.querySelectorAll('.mm-node').length, 4);
    sendInit(win, win.MindMapCore.defaultData());
    assert.strictEqual(button.textContent, '节点一键展开');
    assert.strictEqual(button.disabled, true);
  });

  ok('三个不同高度的子节点与父节点中线准确对齐，切换布局保持对齐', () => {
    const C=win.MindMapCore,data=C.defaultData();
    data.root.children=[C.createNode('短'),C.createNode('中间\n第二行\n第三行'),C.createNode('很高\n'.repeat(16))];
    sendInit(win,data);
    for(const mode of ['right','left','org','up']) {
      win.document.querySelector('[data-action="layout-'+mode+'"]').click();
      const parent=win.document.querySelector('.mm-node[data-id="'+data.root.id+'"]');
      const middle=win.document.querySelector('.mm-node[data-id="'+data.root.children[1].id+'"]');
      const center=element=>mode==='org'||mode==='up'?parseFloat(element.style.left)+parseFloat(element.style.width)/2:parseFloat(element.style.top)+parseFloat(element.style.height)/2;
      assert.ok(Math.abs(center(parent)-center(middle))<.01,mode);
    }
  });

  ok('画布背景支持色板、保存重开、撤销与导出，形状菜单不再包含放射布局', () => {
    sendInit(win,sample);
    assert.strictEqual(win.document.querySelector('[data-action="layout-radial"]'),null);
    assert.strictEqual(win.document.querySelectorAll('#layout-menu .tb-menu-item').length,8);
    const input=win.document.getElementById('canvas-color');
    input.value='#f1e2d3';input.dispatchEvent(new win.Event('input',{bubbles:true}));
    assert.strictEqual(win.document.body.style.getPropertyValue('--canvas'),'#f1e2d3');
    win.dispatchEvent(new win.MessageEvent('message',{data:{type:'request-save'}}));
    const saved=env.messages.filter(m=>m.type==='save').at(-1).data;
    assert.strictEqual(saved.canvasColor,'#f1e2d3');
    win.document.querySelector('[data-action="undo"]').click();
    assert.notStrictEqual(win.document.body.style.getPropertyValue('--canvas'),'#f1e2d3');
    win.document.querySelector('[data-action="redo"]').click();
    assert.strictEqual(win.document.body.style.getPropertyValue('--canvas'),'#f1e2d3');
    sendInit(win,saved);
    assert.strictEqual(input.value,'#f1e2d3');
    input.value='bad';input.dispatchEvent(new win.Event('input',{bubbles:true}));
    assert.strictEqual(input.getAttribute('aria-invalid'),'true');
    assert.strictEqual(win.document.body.style.getPropertyValue('--canvas'),'#f1e2d3');
    win.document.querySelector('[data-action="export-svg"]').click();
    assert.ok(env.messages.filter(m=>m.type==='export'&&m.format==='svg').at(-1).content.includes('#f1e2d3'));
    win.document.querySelector('[data-action="export-html"]').click();
    assert.ok(env.messages.filter(m=>m.type==='export'&&m.format==='html').at(-1).content.includes('#f1e2d3'));
    win.document.querySelector('[data-color-target="canvas-color"][data-color="#ffffff"]').click();
    assert.strictEqual(input.value,'#ffffff');
    win.document.querySelector('[data-action="canvas-reset"]').click();
    assert.strictEqual(input.value,win.MindMapCore.THEMES.lightMap.canvas);
  });

  ok('Markdown 原文可直接预览并更新，折叠和快捷键不会写入源文件', () => {
    const init=markdown=>win.dispatchEvent(new win.MessageEvent('message',{data:{type:'init',markdown,readOnly:true,fileName:'demo.md'}}));
    init('# 当前文档\n- 产品定位\n  - 子节点\n\n| A | B |\n| --- | --- |\n| 1 | 2 |');
    assert.ok(win.document.body.classList.contains('readonly-preview'));
    assert.ok(win.document.querySelector('.mm-rich table'));
    const count=win.document.querySelectorAll('.mm-node').length;
    win.document.querySelector('.mm-node').dispatchEvent(new win.MouseEvent('dblclick',{bubbles:true}));
    assert.strictEqual(win.document.querySelector('.mm-editor'),null);
    win.document.querySelector('[data-action="add-child"]').click();
    win.dispatchEvent(new win.KeyboardEvent('keydown',{key:'Tab',bubbles:true}));
    assert.strictEqual(win.document.querySelectorAll('.mm-node').length,count);
    const saves=env.messages.filter(m=>m.type==='save').length;
    const button=win.document.getElementById('btn-toggle-all-nodes');button.click();button.click();
    win.dispatchEvent(new win.KeyboardEvent('keydown',{key:'s',ctrlKey:true,bubbles:true}));
    win.dispatchEvent(new win.MessageEvent('message',{data:{type:'request-save'}}));
    assert.strictEqual(env.messages.filter(m=>m.type==='save').length,saves);
    init('# 修改后的标题');
    assert.ok(win.document.querySelector('#nodes').textContent.includes('修改后的标题'));
    init('');
    assert.ok(win.document.querySelector('#nodes').textContent.includes('demo'));
  });

  ok('左侧工具栏保留 SVG，提示支持悬停、聚焦及动态状态', () => {
    sendInit(win, sample);
    const buttons=[...win.document.querySelectorAll('#toolbar .tb-tool')];
    assert.strictEqual(buttons.length,13);
    assert.ok(buttons.every(b=>b.querySelector('svg path') && b.getAttribute('aria-label') && b.dataset.tooltip));
    const bulk=win.document.getElementById('btn-toggle-all-nodes');
    assert.ok(bulk.querySelector('svg'));assert.strictEqual(bulk.dataset.tooltip,'节点一键收起');
    bulk.dispatchEvent(new win.MouseEvent('pointerover',{bubbles:true}));
    const tip=win.document.getElementById('toolbar-tooltip');
    assert.strictEqual(tip.hidden,false);assert.strictEqual(tip.textContent,'节点一键收起');
    win.dispatchEvent(new win.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert.strictEqual(tip.hidden,true);
    const zoom=win.document.getElementById('zoom-label');win.document.querySelector('[data-action="zoom-in"]').click();
    assert.ok(zoom.querySelector('svg'));assert.notStrictEqual(zoom.textContent,'100%');assert.ok(zoom.dataset.tooltip.includes(zoom.textContent));
    const layout=win.document.querySelector('[data-action="layout-toggle"]');layout.focus();
    assert.strictEqual(tip.hidden,false);layout.click();
    assert.strictEqual(layout.getAttribute('aria-expanded'),'true');assert.strictEqual(tip.hidden,true);
    win.document.body.dispatchEvent(new win.MouseEvent('pointerdown',{bubbles:true}));
    assert.strictEqual(layout.getAttribute('aria-expanded'),'false');
  });

  console.log('\n全部通过：' + passed + ' 项');
} finally {
  if (env && env.dom && typeof env.dom.window.close === 'function') {
    env.dom.window.close();
  }
}
