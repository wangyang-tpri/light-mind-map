/* ============================================================
 * mindmap.js —— 思维导图 Webview UI 层
 * 渲染（节点/贝塞尔连线）、平移缩放、节点编辑、键盘导航、
 * 拖拽调整结构、折叠/展开、撤销重做、自动保存、导出。
 * 纯逻辑在 core.js（window.MindMapCore）。
 * ============================================================ */
(function () {
  'use strict';

  const C = window.MindMapCore;
  const vscode = acquireVsCodeApi();
  const FONT = '14px -apple-system, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';

  /* ---------------- 状态 ---------------- */
  let model = null;
  let theme = C.THEMES.feishu;
  let selectedId = null;
  let editingId = null;
  let layout = null; // { sideOf, bounds, visible }
  let branchColors = new Map();
  let measure = null;
  let fileName = '思维导图.mindmap';
  let scale = 1;
  let pan = { x: 0, y: 0 };
  let saveTimer = null;
  let isDirty = false;
  let spaceHeld = false;
  let dragState = null; // { id, startX, startY, moved, isRoot }
  let panState = null; // { startX, startY, panX, panY }
  let dropTarget = null;
  let toastTimer = null;
  let fittedOnce = false;
  let layoutMode = 'right'; // standard / right / left

  /* ---------------- DOM ---------------- */
  const canvasWrap = document.getElementById('canvas-wrap');
  const world = document.getElementById('world');
  const edgesSvg = document.getElementById('edges');
  const nodesLayer = document.getElementById('nodes');
  const zoomLabel = document.getElementById('zoom-label');
  const statusText = document.getElementById('status-text');
  const statusCount = document.getElementById('status-count');
  const toastEl = document.getElementById('toast');
  const indicator = document.getElementById('drag-indicator');
  const ghost = document.createElement('div');
  ghost.id = 'ghost';
  document.body.appendChild(ghost);

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const escId = (id) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : String(id));

  /* ---------------- 视图变换 ---------------- */
  const PAD = 60;
  function contentBox() {
    const b = layout.bounds;
    return {
      x: b.minX - PAD,
      y: b.minY - PAD,
      w: b.maxX - b.minX + PAD * 2,
      h: b.maxY - b.minY + PAD * 2,
    };
  }
  function applyTransform() {
    // 用 CSS zoom 替代 transform scale：放大时文字重新栅格化，避免模糊
    world.style.transform = 'translate(' + pan.x + 'px,' + pan.y + 'px)';
    world.style.zoom = String(scale);
    zoomLabel.textContent = Math.round(scale * 100) + '%';
  }
  function screenRect(node) {
    return {
      left: node._rx * scale + pan.x,
      top: node._ry * scale + pan.y,
      w: node._w * scale,
      h: node._h * scale,
    };
  }
  function zoomAt(cx, cy, factor) {
    const ns = clamp(scale * factor, 0.2, 3);
    const k = ns / scale;
    pan.x = cx - (cx - pan.x) * k;
    pan.y = cy - (cy - pan.y) * k;
    scale = ns;
    applyTransform();
  }
  function fitView() {
    if (!layout) return;
    const box = contentBox();
    const rect = canvasWrap.getBoundingClientRect();
    if (box.w <= 0 || box.h <= 0 || rect.width <= 0) return;
    scale = clamp(Math.min(rect.width / box.w, rect.height / box.h, 1.25), 0.2, 2);
    pan.x = (rect.width - box.w * scale) / 2;
    pan.y = (rect.height - box.h * scale) / 2;
    applyTransform();
  }

  /* ---------------- 主题 ---------------- */
  function applyTheme() {
    const t = theme;
    const set = (k, v) => document.body.style.setProperty(k, v);
    set('--canvas', t.canvas);
    set('--node-border', t.nodeBorder);
    set('--node-fill', t.nodeFill);
    set('--node-text', t.nodeText);
    set('--sel', t.selectedBorder);
    set('--sel-bg', t.selectedBg || 'rgba(51,112,255,0.08)');
    set('--hover', t.hoverBorder);
    set('--collapse-bg', t.collapseBg);
    set('--collapse-border', t.collapseBorder);
    set('--collapse-text', t.collapseText);
    set('--glow', t.selectedGlow);
    canvasWrap.style.background = t.canvas;
  }

  /* ---------------- 选择 ---------------- */
  function selectNode(id) {
    selectedId = id;
    const sels = nodesLayer.querySelectorAll('.mm-node.selected');
    for (let i = 0; i < sels.length; i++) sels[i].classList.remove('selected');
    if (id) {
      const el = nodesLayer.querySelector('.mm-node[data-id="' + escId(id) + '"]');
      if (el) el.classList.add('selected');
    }
  }

  /* ---------------- 渲染 ---------------- */
  function render() {
    if (!model) return;
    // 保险性隐藏拖拽指示器，避免拖拽后残留
    if (indicator) indicator.style.display = 'none';
    layout = C.layoutTree(model.root, measure, layoutMode);
    branchColors = C.assignBranchColors(model.root, theme);
    const box = contentBox();
    world.style.width = box.w + 'px';
    world.style.height = box.h + 'px';
    nodesLayer.innerHTML = '';
    edgesSvg.setAttribute('width', box.w);
    edgesSvg.setAttribute('height', box.h);
    edgesSvg.innerHTML = '';

    for (let i = 0; i < layout.visible.length; i++) {
      const node = layout.visible[i];
      node._rx = node._x - box.x;
      node._ry = node._y - box.y;
      createNodeEl(node);
    }
    drawEdges();
    selectNode(selectedId);
    document.getElementById('btn-undo').disabled = !model.canUndo();
    document.getElementById('btn-redo').disabled = !model.canRedo();
    updateStatus();
    if (!fittedOnce) {
      fittedOnce = true;
      fitView();
    }
  }

  function createNodeEl(node) {
    const color = branchColors.get(node.id) || theme.rootFill;
    const isRoot = node === model.root;
    const el = document.createElement('div');
    el.className = 'mm-node' + (node._side === 'left' ? ' left' : '');
    el.dataset.id = node.id;
    el.style.left = node._rx + 'px';
    el.style.top = node._ry + 'px';
    el.style.width = node._w + 'px';
    el.style.minHeight = node._h + 'px';
    if (isRoot) {
      el.style.background = theme.rootFill;
      el.style.border = '1.5px solid ' + theme.rootFill;
      el.style.color = theme.rootText;
      el.style.fontWeight = '600';
      el.style.boxShadow = '0 2px 10px rgba(0,0,0,.12)';
    }
    const span = document.createElement('div');
    span.className = 'mm-node-text';
    span.textContent = node.text;
    el.appendChild(span);

    if (node.children.length) {
      const btn = document.createElement('div');
      btn.className = 'mm-collapse ' + (node._side === 'left' && !isRoot ? 'left' : 'right');
      btn.textContent = node.collapsed ? '→' : '←';
      btn.title = node.collapsed ? '展开' : '折叠';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (editingId) commitEdit();
        model.toggleCollapse(node.id);
        render();
        scheduleSave();
      });
      el.appendChild(btn);
    }

    // 选中态右侧加号按钮：点击添加子主题
    if (!isRoot) {
      const addBtn = document.createElement('div');
      addBtn.className = 'mm-add-btn';
      addBtn.textContent = '+';
      addBtn.title = '添加子主题';
      addBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (editingId) commitEdit();
        selectNode(node.id);
        const n = model.addChild(node.id, '');
        render();
        scheduleSave();
        if (n) startEdit(n.id);
      });
      el.appendChild(addBtn);
    }
    nodesLayer.appendChild(el);
  }

  function drawEdges() {
    let svg = '';
    const GAP = 8;   // 连线端点与节点边框的间隙
    const SEG = 22;  // 水平段长度（节点边缘到垂直骨干）
    const R = 14;    // 圆角半径
    const color = theme.rootFill;
    for (let i = 0; i < layout.visible.length; i++) {
      const node = layout.visible[i];
      const children = node.collapsed ? [] : node.children;
      if (!children.length) continue;
      // 按侧分组（左右侧的垂直骨干 x 不同）
      const sides = { right: [], left: [] };
      children.forEach((c) => {
        const s = c._side === 'left' ? 'left' : 'right';
        sides[s].push(c);
      });
      for (const side of ['right', 'left']) {
        const sc = sides[side];
        if (!sc.length) continue;
        const dir = side === 'right' ? 1 : -1;
        const px = dir === 1 ? node._rx + node._w : node._rx;
        const py = node._ry + node._h / 2;
        // 子节点中心 y 范围
        let minCY = Infinity, maxCY = -Infinity;
        sc.forEach((c) => {
          const cy = c._ry + c._h / 2;
          if (cy < minCY) minCY = cy;
          if (cy > maxCY) maxCY = cy;
        });
        // 单子节点且同高：直接画水平直线
        if (sc.length === 1 && Math.abs(py - (sc[0]._ry + sc[0]._h / 2)) < 4) {
          const child = sc[0];
          const cx = dir === 1 ? child._rx : child._rx + child._w;
          svg +=
            '<path d="M' + (px + dir * GAP) + ',' + py +
            ' L' + (cx - dir * GAP) + ',' + py +
            '" fill="none" stroke="' + color + '" stroke-width="2" stroke-linecap="round"/>';
          continue;
        }
        const firstCX = dir === 1 ? sc[0]._rx : sc[0]._rx + sc[0]._w;
        const dx = Math.abs(firstCX - px);
        const seg = Math.min(SEG, Math.max(4, dx / 2 - GAP - 2));
        const r = Math.min(R, Math.max(3, seg * 0.6));
        const bx = px + dir * (GAP + seg); // 垂直骨干 x
        const sx = px + dir * GAP;
        const q1x = bx - dir * r;
        // 1. 父节点水平段 + 向上圆角/垂直段 + 向下圆角/垂直段（共享垂直骨干，只画一次）
        let trunk = 'M' + sx + ',' + py + ' L' + q1x + ',' + py;
        if (minCY < py - 1) {
          trunk += ' Q' + bx + ',' + py + ' ' + bx + ',' + (py - r) + ' L' + bx + ',' + (minCY + r);
        }
        if (maxCY > py + 1) {
          trunk += ' M' + q1x + ',' + py + ' Q' + bx + ',' + py + ' ' + bx + ',' + (py + r) + ' L' + bx + ',' + (maxCY - r);
        }
        svg += '<path d="' + trunk + '" fill="none" stroke="' + color + '" stroke-width="2" stroke-linecap="round"/>';
        // 2. 每个子节点：从垂直骨干圆角到水平 + 水平段（各画一次，不重叠）
        sc.forEach((child) => {
          const cy = child._ry + child._h / 2;
          const cx = dir === 1 ? child._rx : child._rx + child._w;
          const ex = cx - dir * GAP;
          const q2x = bx + dir * r;
          const vStart = cy < py ? cy + r : cy - r;
          svg +=
            '<path d="M' + bx + ',' + vStart +
            ' Q' + bx + ',' + cy + ' ' + q2x + ',' + cy +
            ' L' + ex + ',' + cy +
            '" fill="none" stroke="' + color + '" stroke-width="2" stroke-linecap="round"/>';
        });
      }
    }
    edgesSvg.innerHTML = svg;
  }

  function updateStatus() {
    statusCount.textContent = model ? C.countNodes(model.root) + ' 个节点' : '';
  }

  /* ---------------- 编辑 ---------------- */
  function startEdit(id) {
    const node = model.find(id);
    if (!node) return;
    if (editingId) commitEdit();
    editingId = id;
    const el = nodesLayer.querySelector('.mm-node[data-id="' + escId(id) + '"]');
    if (!el) return;
    // 编辑时隐藏节点自身边框/背景，避免与编辑框叠加出"双边框"
    el.classList.add('editing');
    const ta = document.createElement('textarea');
    ta.className = 'mm-editor';
    ta.value = node.text;
    el.appendChild(ta);
    ta.focus();
    ta.select();
    // 输入时实时重新布局：临时更新文字 → layoutTree → 更新所有节点位置（不重建DOM，保持textarea） → 重绘连线
    ta.addEventListener('input', () => {
      // 单行最多100字符，超过自动换行
      const MAX_CHARS = 100;
      const raw = ta.value;
      const selStart = ta.selectionStart;
      const lines = raw.split('\n');
      let wrapped = '';
      let cursorOffset = 0; // 自动换行插入的 \n 数量（光标前）
      let pos = 0;
      for (let li = 0; li < lines.length; li++) {
        const line = lines[li];
        if (line.length <= MAX_CHARS) {
          wrapped += line;
          pos += line.length;
        } else {
          for (let i = 0; i < line.length; i += MAX_CHARS) {
            const chunk = line.slice(i, i + MAX_CHARS);
            wrapped += chunk;
            pos += chunk.length;
            if (i + MAX_CHARS < line.length) {
              wrapped += '\n';
              if (pos < selStart) cursorOffset++;
            }
          }
        }
        if (li < lines.length - 1) {
          wrapped += '\n';
          pos++;
        }
      }
      let text = wrapped;
      if (text !== raw) {
        ta.value = text;
        const newPos = Math.min(selStart + cursorOffset, text.length);
        ta.setSelectionRange(newPos, newPos);
      }
      const node = model.find(id);
      if (!node) return;
      const oldText = node.text;
      node.text = text; // 临时更新，仅用于布局计算
      try {
        const newLayout = C.layoutTree(model.root, measure, layoutMode);
        const newBounds = newLayout.bounds;
        layout = newLayout;
        // 重新计算渲染坐标（与 render() 中 _rx/_ry 一致）
        const boxX = newBounds.minX - PAD;
        const boxY = newBounds.minY - PAD;
        newLayout.visible.forEach(function (n) {
          n._rx = n._x - boxX;
          n._ry = n._y - boxY;
        });
        // 同步更新容器尺寸，避免连线被裁剪
        const boxW = newBounds.maxX - newBounds.minX + PAD * 2;
        const boxH = newBounds.maxY - newBounds.minY + PAD * 2;
        world.style.width = boxW + 'px';
        world.style.height = boxH + 'px';
        edgesSvg.setAttribute('width', boxW);
        edgesSvg.setAttribute('height', boxH);
        // 更新所有节点 DOM 的位置和尺寸（不重建，保持编辑框不丢失）
        const nodeEls = nodesLayer.querySelectorAll('.mm-node');
        nodeEls.forEach(function (domEl) {
          const nid = domEl.dataset.id;
          const ln = newLayout.visible.find(function (n) { return n.id === nid; });
          if (ln) {
            domEl.style.left = ln._rx + 'px';
            domEl.style.top = ln._ry + 'px';
            if (nid !== id) {
              // 非编辑节点：从布局更新尺寸
              domEl.style.width = ln._w + 'px';
              domEl.style.minHeight = ln._h + 'px';
            }
          }
        });
        // 当前编辑节点：用测量值更新尺寸（与 textarea 一致）
        const s = measure(text);
        el.style.width = (s.width + C.LAYOUT.PAD_X * 2) + 'px';
        el.style.minHeight = (s.height + C.LAYOUT.PAD_Y * 2) + 'px';
        drawEdges();
      } finally {
        node.text = oldText; // 恢复，commitEdit 时才真正写入 model
      }
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        commitEdit();
      } else if (e.key === 'Escape' && !e.isComposing) {
        e.preventDefault();
        cancelEdit();
      } else if (e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        // 编辑态下 Tab：提交当前编辑，添加子节点并进入编辑
        const curId = editingId;
        commitEdit();
        const n = model.addChild(curId, '');
        render();
        scheduleSave();
        if (n) startEdit(n.id);
      }
    });
    ta.addEventListener('blur', () => commitEdit());
  }

  function commitEdit() {
    if (!editingId) return;
    const id = editingId;
    const ta = nodesLayer.querySelector('.mm-editor');
    if (ta) {
      const text = ta.value;
      const node = model.find(id);
      if (node && text !== node.text) {
        model.setText(id, text);
        scheduleSave();
      }
      ta.remove();
    }
    editingId = null;
    render();
    selectNode(id);
  }

  function cancelEdit() {
    if (!editingId) return;
    const ta = nodesLayer.querySelector('.mm-editor');
    if (ta) ta.remove();
    editingId = null;
    render();
  }

  /* ---------------- 撤销 / 重做 ---------------- */
  function undo() {
    if (!model.canUndo()) return;
    const prev = selectedId;
    model.undo();
    render();
    if (prev && model.find(prev)) selectNode(prev);
    else selectNode(null);
    scheduleSave();
  }
  function redo() {
    if (!model.canRedo()) return;
    const prev = selectedId;
    model.redo();
    render();
    if (prev && model.find(prev)) selectNode(prev);
    else selectNode(null);
    scheduleSave();
  }

  /* ---------------- 键盘导航 ---------------- */
  function navigate(key) {
    if (!selectedId) {
      selectNode(model.root.id);
      return;
    }
    const order = layout.visible;
    const idx = order.findIndex((n) => n.id === selectedId);
    if (idx < 0) return;
    const sel = order[idx];
    if (key === 'ArrowDown' && idx < order.length - 1) { selectNode(order[idx + 1].id); startEdit(order[idx + 1].id); }
    else if (key === 'ArrowUp' && idx > 0) { selectNode(order[idx - 1].id); startEdit(order[idx - 1].id); }
    else if (key === 'ArrowRight') {
      if (sel.children.length) {
        if (sel.collapsed) {
          model.setCollapsed(sel.id, false);
          render();
        } else {
          selectNode(sel.children[0].id);
          startEdit(sel.children[0].id);
        }
      }
    } else if (key === 'ArrowLeft') {
      if (sel.children.length && !sel.collapsed) {
        model.setCollapsed(sel.id, true);
        render();
      } else {
        const p = C.findParent(model.root, sel.id);
        if (p) { selectNode(p.id); startEdit(p.id); }
      }
    }
  }

  function onKeyDown(e) {
    // 输入控件内的按键由控件自己处理，避免提交/换行事件冒泡触发全局快捷键
    const tag = e.target && e.target.tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') return;
    if (editingId) return; // 编辑框自己处理按键
    const mod = e.ctrlKey || e.metaKey;

    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      redo();
      return;
    }
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      saveNow();
      return;
    }
    if (mod && (e.key === '+' || e.key === '=')) {
      e.preventDefault();
      const r = canvasWrap.getBoundingClientRect();
      zoomAt(r.width / 2, r.height / 2, 1.2);
      return;
    }
    if (mod && e.key === '-') {
      e.preventDefault();
      const r = canvasWrap.getBoundingClientRect();
      zoomAt(r.width / 2, r.height / 2, 1 / 1.2);
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      if (!selectedId) {
        selectNode(model.root.id);
        return;
      }
      if (e.shiftKey) {
        model.promote(selectedId);
        render();
        scheduleSave();
      } else {
        const n = model.addChild(selectedId, '');
        render();
        scheduleSave();
        if (n) startEdit(n.id);
      }
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!selectedId) {
        selectNode(model.root.id);
        return;
      }
      const n = model.addSibling(selectedId, '', e.shiftKey);
      render();
      scheduleSave();
      if (n) startEdit(n.id);
      return;
    }
    if (e.key === 'F2') {
      e.preventDefault();
      if (selectedId) startEdit(selectedId);
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (selectedId && selectedId !== model.root.id) {
        e.preventDefault();
        model.removeNode(selectedId);
        selectNode(null);
        render();
        scheduleSave();
      } else if (selectedId === model.root.id) {
        e.preventDefault();
        toast('根节点不可删除');
      }
      return;
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      navigate(e.key);
      return;
    }
    if (e.key === 'Escape') {
      if (dragState) {
        cancelDrag();
        return;
      }
      if (selectedId) {
        const sel = model.find(selectedId);
        if (sel && sel.children.length && !sel.collapsed) {
          model.setCollapsed(sel.id, true);
          render();
          scheduleSave();
        } else {
          const p = C.findParent(model.root, selectedId);
          if (p) selectNode(p.id);
        }
      }
      return;
    }
    if (e.key === ' ') {
      spaceHeld = true;
      e.preventDefault();
    }
  }

  function onKeyUp(e) {
    if (e.key === ' ') spaceHeld = false;
  }

  /* ---------------- 拖拽调整结构 ---------------- */
  function onNodePointerDown(e) {
    if (e.button !== 0) return;
    if (editingId) commitEdit();
    const el = e.target.closest('.mm-node');
    if (!el) return;
    if (e.target.closest('.mm-collapse')) return; // 折叠按钮自己处理
    const id = el.dataset.id;
    selectNode(id);
    dragState = {
      id: id,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      isRoot: id === model.root.id,
    };
    e.preventDefault();
  }

  function onCanvasPointerDown(e) {
    if (e.button === 1 || spaceHeld) {
      startPan(e);
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;
    if (e.target.closest('.mm-node') || e.target.closest('.mm-collapse')) return;
    selectNode(null);
    startPan(e);
  }

  function startPan(e) {
    panState = { startX: e.clientX, startY: e.clientY, panX: pan.x, panY: pan.y };
    canvasWrap.classList.add('panning');
  }

  function onPointerMove(e) {
    if (dragState && dragState.moved) {
      updateDrag(e);
      return;
    }
    if (dragState && !dragState.moved) {
      if (Math.hypot(e.clientX - dragState.startX, e.clientY - dragState.startY) > 4) {
        dragState.moved = true;
        beginDragVisual();
      } else {
        return;
      }
    }
    if (panState) {
      pan.x = panState.panX + (e.clientX - panState.startX);
      pan.y = panState.panY + (e.clientY - panState.startY);
      applyTransform();
    }
  }

  function beginDragVisual() {
    const node = model.find(dragState.id);
    ghost.textContent = node ? node.text : '';
    ghost.style.display = 'block';
    const el = nodesLayer.querySelector('.mm-node[data-id="' + escId(dragState.id) + '"]');
    if (el) el.classList.add('dragging');
    canvasWrap.classList.add('dragging');
    if (dragState.isRoot) toast('根节点不可移动');
  }

  function updateDrag(e) {
    ghost.style.left = e.clientX + 14 + 'px';
    ghost.style.top = e.clientY + 10 + 'px';
    if (dragState.isRoot) {
      hideIndicator();
      return;
    }
    dropTarget = hitTest(e.clientX, e.clientY);
    if (dropTarget) showIndicator(dropTarget);
    else hideIndicator();
  }

  function hitTest(x, y) {
    let best = null;
    for (let i = 0; i < layout.visible.length; i++) {
      const node = layout.visible[i];
      if (node.id === dragState.id) continue;
      if (C.isDescendant(model.root, dragState.id, node.id)) continue;
      const r = screenRect(node);
      if (x >= r.left && x <= r.left + r.w && y >= r.top && y <= r.top + r.h) {
        const area = r.w * r.h;
        if (!best || area < best.area) best = { id: node.id, rect: r, area: area };
      }
    }
    if (!best) return null;
    const r = best.rect;
    const dy = (y - r.top) / r.h;
    let where = 'child';
    if (dy < 0.3) where = 'before';
    else if (dy > 0.7) where = 'after';
    if (best.id === model.root.id && where !== 'child') where = 'child';
    return { id: best.id, where: where, rect: r };
  }

  function showIndicator(t) {
    indicator.style.display = 'block';
    if (t.where === 'child') {
      indicator.className = 'drop-child';
      indicator.style.left = t.rect.left + 'px';
      indicator.style.top = t.rect.top + 'px';
      indicator.style.width = t.rect.w + 'px';
      indicator.style.height = t.rect.h + 'px';
    } else {
      indicator.className = 'drop-line';
      indicator.style.left = t.rect.left + 'px';
      indicator.style.width = t.rect.w + 'px';
      indicator.style.height = '3px';
      indicator.style.top = (t.where === 'before' ? t.rect.top - 1 : t.rect.top + t.rect.h - 1) + 'px';
    }
  }

  function hideIndicator() {
    indicator.style.display = 'none';
  }

  function cancelDrag() {
    dragState = null;
    dropTarget = null;
    hideIndicator();
    ghost.style.display = 'none';
    canvasWrap.classList.remove('dragging');
    const els = nodesLayer.querySelectorAll('.mm-node.dragging');
    for (let i = 0; i < els.length; i++) els[i].classList.remove('dragging');
  }

  function onPointerUp() {
    if (dragState && dragState.moved && !dragState.isRoot && dropTarget) {
      const id = dragState.id;
      const target = dropTarget;
      cancelDrag();
      if (model.moveNode(id, target.id, target.where)) {
        selectNode(id);
        render();
        scheduleSave();
      }
      return;
    }
    cancelDrag();
    if (panState) {
      panState = null;
      canvasWrap.classList.remove('panning');
    }
  }

  /* ---------------- 保存 ---------------- */
  function scheduleSave() {
    isDirty = true;
    statusText.textContent = '保存中…';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 800);
  }
  function saveNow() {
    clearTimeout(saveTimer);
    if (!isDirty || !model) return;
    isDirty = false;
    vscode.postMessage({ type: 'save', data: model.data });
  }

  /* ---------------- 导出 ---------------- */
  function baseName() {
    const f = fileName.replace(/\.mindmap$/i, '').replace(/\.mindm$/i, '');
    return f || '思维导图';
  }
  function exportMarkdown() {
    vscode.postMessage({
      type: 'export',
      format: 'markdown',
      content: C.markdownExport(model.data),
      defaultName: baseName(),
    });
  }
  function exportHtml() {
    vscode.postMessage({
      type: 'export',
      format: 'html',
      content: C.htmlExport(model.data),
      defaultName: baseName(),
    });
  }
  function exportPng() {
    try {
      const dataUrl = renderPng();
      vscode.postMessage({
        type: 'export',
        format: 'png',
        pngBase64: dataUrl.split(',')[1],
        defaultName: baseName(),
      });
    } catch (err) {
      toast('PNG 导出失败：' + err.message);
    }
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function renderPng() {
    const box = contentBox();
    // 缩放 1.5 倍（平衡清晰度与文件大小，避免节点元素过大）
    const s = Math.min(1.5, 4096 / Math.max(box.w, box.h, 1));
    const W = Math.max(1, Math.ceil(box.w * s));
    const H = Math.max(1, Math.ceil(box.h * s));
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = theme.canvas;
    ctx.fillRect(0, 0, W, H);
    ctx.font = FONT;
    ctx.textBaseline = 'middle';
    ctx.lineCap = 'round';

    // 连线（共享垂直骨干，避免多子节点时线条重合）
    const GAP = 8 * s;
    const SEG = 22 * s;
    const R = 14 * s;
    const color = theme.rootFill;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2 * s;
    ctx.lineCap = 'round';
    for (let i = 0; i < layout.visible.length; i++) {
      const node = layout.visible[i];
      const children = node.collapsed ? [] : node.children;
      if (!children.length) continue;
      const sides = { right: [], left: [] };
      children.forEach((c) => {
        const sd = c._side === 'left' ? 'left' : 'right';
        sides[sd].push(c);
      });
      for (const side of ['right', 'left']) {
        const sc = sides[side];
        if (!sc.length) continue;
        const dir = side === 'right' ? 1 : -1;
        const px = (dir === 1 ? node._rx + node._w : node._rx) * s;
        const py = (node._ry + node._h / 2) * s;
        let minCY = Infinity, maxCY = -Infinity;
        sc.forEach((c) => {
          const cy = (c._ry + c._h / 2) * s;
          if (cy < minCY) minCY = cy;
          if (cy > maxCY) maxCY = cy;
        });
        // 单子节点同高：水平直线
        if (sc.length === 1 && Math.abs(py - (sc[0]._ry + sc[0]._h / 2) * s) < 4 * s) {
          const child = sc[0];
          const cx = (dir === 1 ? child._rx : child._rx + child._w) * s;
          ctx.beginPath();
          ctx.moveTo(px + dir * GAP, py);
          ctx.lineTo(cx - dir * GAP, py);
          ctx.stroke();
          continue;
        }
        const firstCX = (dir === 1 ? sc[0]._rx : sc[0]._rx + sc[0]._w) * s;
        const dx = Math.abs(firstCX - px);
        const seg = Math.min(SEG, Math.max(4 * s, dx / 2 - GAP - 2 * s));
        const r = Math.min(R, Math.max(3 * s, seg * 0.6));
        const bx = px + dir * (GAP + seg);
        const sx = px + dir * GAP;
        const q1x = bx - dir * r;
        // 父节点水平段 + 向上圆角/垂直段 + 向下圆角/垂直段（共享骨干）
        ctx.beginPath();
        ctx.moveTo(sx, py);
        ctx.lineTo(q1x, py);
        if (minCY < py - 1) {
          ctx.quadraticCurveTo(bx, py, bx, py - r);
          ctx.lineTo(bx, minCY + r);
        }
        if (maxCY > py + 1) {
          ctx.moveTo(q1x, py);
          ctx.quadraticCurveTo(bx, py, bx, py + r);
          ctx.lineTo(bx, maxCY - r);
        }
        ctx.stroke();
        // 每个子节点：从垂直骨干圆角到水平 + 水平段
        sc.forEach((child) => {
          const cy = (child._ry + child._h / 2) * s;
          const cx = (dir === 1 ? child._rx : child._rx + child._w) * s;
          const ex = cx - dir * GAP;
          const q2x = bx + dir * r;
          const vStart = cy < py ? cy + r : cy - r;
          ctx.beginPath();
          ctx.moveTo(bx, vStart);
          ctx.quadraticCurveTo(bx, cy, q2x, cy);
          ctx.lineTo(ex, cy);
          ctx.stroke();
        });
      }
    }

    // 节点
    const lh = 20;
    for (let i = 0; i < layout.visible.length; i++) {
      const node = layout.visible[i];
      const x = node._rx * s;
      const y = node._ry * s;
      const w = node._w * s;
      const h = node._h * s;
      const isRoot = node === model.root;
      const color = branchColors.get(node.id) || theme.rootFill;
      if (isRoot) {
        ctx.fillStyle = theme.rootFill;
        roundRect(ctx, x, y, w, h, 8 * s);
        ctx.fill();
        ctx.strokeStyle = theme.rootFill;
        ctx.lineWidth = Math.max(1, s);
        ctx.stroke();
      }
      // 普通节点：无背景无边框，只绘制文字
      ctx.fillStyle = isRoot ? theme.rootText : theme.nodeText;
      if (isRoot) {
        ctx.font = '600 ' + FONT;
      } else {
        ctx.font = FONT;
      }
      ctx.textAlign = 'center';
      // 自动换行（与 createMeasure 的 maxWidth=360 一致，内容区域最大宽度）
      var maxW = 360 * s;
      var rawLines = String(node.text).split('\n');
      var lines = [];
      for (var ri = 0; ri < rawLines.length; ri++) {
        var rline = rawLines[ri];
        if (ctx.measureText(rline).width <= maxW || rline.length === 0) {
          lines.push(rline);
        } else {
          var cur = '';
          var curW = 0;
          for (var ci = 0; ci < rline.length; ci++) {
            var ch = rline[ci];
            var cw = ctx.measureText(ch).width;
            if (curW + cw > maxW && cur.length > 0) {
              lines.push(cur);
              cur = ch;
              curW = cw;
            } else {
              cur += ch;
              curW += cw;
            }
          }
          if (cur.length > 0) lines.push(cur);
        }
      }
      const startY = y + h / 2 - ((lines.length - 1) * lh * s) / 2;
      for (let li = 0; li < lines.length; li++) {
        ctx.fillText(lines[li], x + w / 2, startY + li * lh * s);
      }
      if (node.children.length) {
        // 折叠按钮完全在节点外侧（与画布 CSS right:-16px / left:-16px 一致），避免与长文字重合
        const cx = node._side === 'left' && !isRoot ? x - 8 * s : x + w + 8 * s;
        const cy = y + h / 2;
        ctx.beginPath();
        ctx.arc(cx, cy, 8 * s, 0, Math.PI * 2);
        ctx.fillStyle = theme.collapseBg;
        ctx.fill();
        ctx.strokeStyle = theme.collapseBorder;
        ctx.lineWidth = Math.max(1, s);
        ctx.stroke();
        ctx.fillStyle = theme.collapseText;
        ctx.font = '12px sans-serif';
        ctx.fillText(node.collapsed ? '+' : '−', cx, cy + 1 * s);
      }
    }
    return canvas.toDataURL('image/png');
  }

  /* ---------------- 工具栏 ---------------- */
  function buildThemeMenu() {
    const menu = document.getElementById('theme-menu');
    const keys = Object.keys(C.THEMES);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const item = document.createElement('div');
      item.className = 'tb-menu-item';
      item.textContent = C.THEMES[key].name;
      item.dataset.theme = key;
      item.addEventListener('click', () => {
        setTheme(key);
        toggleMenu('theme-menu', true);
      });
      menu.appendChild(item);
    }
  }
  function setTheme(key) {
    theme = C.THEMES[key] || C.THEMES.feishu;
    applyTheme();
    render();
  }

  function toggleMenu(menuId, forceClose) {
    const menus = document.querySelectorAll('.tb-menu');
    for (let i = 0; i < menus.length; i++) {
      const m = menus[i];
      if (m.id === menuId && !forceClose) m.classList.toggle('open');
      else m.classList.remove('open');
    }
  }

  function onToolbarClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    switch (action) {
      case 'add-child': {
        const parentId = selectedId || model.root.id;
        const n = model.addChild(parentId, '');
        render();
        scheduleSave();
        if (n) startEdit(n.id);
        break;
      }
      case 'undo':
        undo();
        break;
      case 'redo':
        redo();
        break;
      case 'zoom-in': {
        const r = canvasWrap.getBoundingClientRect();
        zoomAt(r.width / 2, r.height / 2, 1.2);
        break;
      }
      case 'zoom-out': {
        const r = canvasWrap.getBoundingClientRect();
        zoomAt(r.width / 2, r.height / 2, 1 / 1.2);
        break;
      }
      case 'fit':
        fitView();
        break;
      case 'layout-toggle':
        toggleMenu('layout-menu');
        break;
      case 'layout-standard':
        layoutMode = 'standard';
        render();
        toggleMenu('layout-menu', true);
        break;
      case 'layout-right':
        layoutMode = 'right';
        render();
        toggleMenu('layout-menu', true);
        break;
      case 'layout-left':
        layoutMode = 'left';
        render();
        toggleMenu('layout-menu', true);
        break;
      case 'theme-toggle':
        toggleMenu('theme-menu');
        break;
      case 'export-toggle':
        toggleMenu('export-menu');
        break;
      case 'export-markdown':
        exportMarkdown();
        toggleMenu('export-menu', true);
        break;
      case 'export-html':
        exportHtml();
        toggleMenu('export-menu', true);
        break;
      case 'export-png':
        exportPng();
        toggleMenu('export-menu', true);
        break;
      default:
        break;
    }
  }

  /* ---------------- 消息 ---------------- */
  function initDoc(msg) {
    fileName = msg.fileName || '思维导图.mindmap';
    const data = msg.data || C.defaultData();
    model = new C.MindMapModel(data);
    measure = C.createMeasure(FONT, 360);
    if (msg.theme && C.THEMES[msg.theme]) theme = C.THEMES[msg.theme];
    applyTheme();
    render();
    statusText.textContent = '就绪';
    if (msg.parseError) {
      toast('文件解析失败，已打开空白画布：' + msg.parseError);
    }
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'init') {
      initDoc(msg);
    } else if (msg.type === 'saved') {
      statusText.textContent = '已保存';
    } else if (msg.type === 'request-save') {
      saveNow();
    } else if (msg.type === 'error') {
      statusText.textContent = '错误';
      toast(msg.message || '发生错误');
    }
  });

  /* ---------------- 提示 ---------------- */
  function toast(text) {
    toastEl.textContent = text;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
  }

  /* ---------------- 事件绑定 ---------------- */
  document.getElementById('toolbar').addEventListener('click', onToolbarClick);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', () => {
    spaceHeld = false;
  });

  nodesLayer.addEventListener('pointerdown', onNodePointerDown);
  canvasWrap.addEventListener('pointerdown', onCanvasPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);

  // 单击已选中的节点时进入编辑态（拖拽后不触发 click）
  nodesLayer.addEventListener('click', (e) => {
    const el = e.target.closest('.mm-node');
    if (!el) return;
    if (e.target.closest('.mm-collapse') || e.target.closest('.mm-add-btn')) return;
    const id = el.dataset.id;
    if (id === selectedId && !editingId) {
      startEdit(id);
    }
  });

  nodesLayer.addEventListener('dblclick', (e) => {
    const el = e.target.closest('.mm-node');
    if (!el) return;
    if (e.target.closest('.mm-collapse')) return;
    startEdit(el.dataset.id);
  });

  canvasWrap.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const rect = canvasWrap.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      if (e.ctrlKey || e.metaKey) {
        zoomAt(cx, cy, e.deltaY < 0 ? 1.1 : 1 / 1.1);
      } else {
        pan.x -= e.deltaX;
        pan.y -= e.deltaY;
        applyTransform();
      }
    },
    { passive: false }
  );

  buildThemeMenu();
  applyTheme();
  vscode.postMessage({ type: 'ready' });
})();

