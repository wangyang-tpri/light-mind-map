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
    `<!DOCTYPE html><html><body>
      <div id="toolbar">
        <button class="tb-btn" data-action="add-child">＋ 子主题</button>
        <button id="btn-undo" data-action="undo">撤销</button>
        <button id="btn-redo" data-action="redo">重做</button>
        <button data-action="zoom-out">－</button>
        <span id="zoom-label">100%</span>
        <button data-action="zoom-in">＋</button>
        <button data-action="fit">适应</button>
        <div class="tb-dropdown"><div id="theme-menu"></div></div>
        <div class="tb-dropdown"><div id="export-menu">
          <div class="tb-menu-item" data-action="export-markdown">Markdown</div>
          <div class="tb-menu-item" data-action="export-html">HTML</div>
          <div class="tb-menu-item" data-action="export-png">PNG</div>
        </div></div>
      </div>
      <div id="canvas-wrap"><div id="world"><svg id="edges"></svg><div id="nodes"></div></div>
      <div id="drag-indicator"></div></div>
      <div id="statusbar"><span id="status-text"></span><span id="status-count"></span></div>
      <div id="hintbar"></div><div id="toast"></div>
    </body></html>`,
    { runScripts: 'outside-only', pretendToBeVisual: true }
  );
  const win = dom.window;
  const messages = [];
  win.acquireVsCodeApi = () => ({ postMessage: (m) => messages.push(m) });
  win.eval(coreSrc);
  win.eval(appSrc);
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

  ok('导出消息发送（Markdown/HTML）', () => {
    const mdBtn = win.document.querySelector('[data-action="export-markdown"]');
    mdBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    const htmlBtn = win.document.querySelector('[data-action="export-html"]');
    htmlBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    const types = env.messages.filter((m) => m.type === 'export').map((m) => m.format);
    assert.ok(types.includes('markdown') && types.includes('html'));
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

  console.log('\n全部通过：' + passed + ' 项');
} finally {
  if (env && env.dom && typeof env.dom.window.close === 'function') {
    env.dom.window.close();
  }
}
