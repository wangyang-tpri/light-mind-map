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
  let relationSource = null;
  let selectedRelationId = null;
  let relationDrag = null;
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
    world.style.transform = 'translate(' + (pan.x / scale) + 'px,' + (pan.y / scale) + 'px)';
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
    if (window.MindMapRich) window.MindMapRich.prepare(model.root, () => {
      if (!editingId && model) { render(); fitView(); }
    });
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
    document.querySelectorAll('#layout-menu [data-action]').forEach(item => {
      const active = item.dataset.action === 'layout-' + layoutMode;
      item.classList.toggle('active', active);
      item.setAttribute('aria-checked', String(active));
      item.setAttribute('role', 'menuitemradio');
    });
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
    el.style.height = node._h + 'px';
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
    span.textContent = node.text || (isRoot ? '中心主题' : '输入文本');
    span.classList.toggle('placeholder', !node.text);
    el.setAttribute('aria-label', node.text || '输入文本');
    if (node.content && window.MindMapRich) {
      el.classList.add('rich-node');
      el.appendChild(window.MindMapRich.element(node));
    } else el.appendChild(span);

    if (node.children.length) {
      const btn = document.createElement('div');
      btn.className = 'mm-collapse ' + (node._side === 'left' && !isRoot ? 'left' : 'right');
      btn.textContent = node.collapsed ? '+' : '−';
      if (node.collapsed) btn.classList.add('collapsed');
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
    {
      const addBtn = document.createElement('div');
      addBtn.className = 'mm-add-btn' + (node._side === 'left' ? ' left' : '');
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

  function relationPaths() {
    const visible = new Map(layout.visible.map(node => [node.id, node]));
    return (model.data.relations || []).flatMap(link => {
      const a = visible.get(link.from), b = visible.get(link.to);
      if (!a || !b) return [];
      const ax = a._rx + a._w / 2, ay = a._ry + a._h / 2;
      const bx = b._rx + b._w / 2, by = b._ry + b._h / 2;
      const preview = relationDrag && relationDrag.id === link.id ? relationDrag : link;
      const c1 = preview.control1 || { x: (bx - ax) / 3, y: (by - ay) / 3 };
      const c2 = preview.control2 || { x: (ax - bx) / 3, y: (ay - by) / 3 };
      const p1 = { x: ax + c1.x, y: ay + c1.y }, p2 = { x: bx + c2.x, y: by + c2.y };
      const edge = (node, x, y, toward) => {
        let dx = toward.x - x, dy = toward.y - y;
        if (Math.abs(dx) + Math.abs(dy) < 0.01) { dx = bx - ax; dy = by - ay; }
        const t = Math.min(dx ? node._w / 2 / Math.abs(dx) : Infinity, dy ? node._h / 2 / Math.abs(dy) : Infinity);
        return { x: x + dx * t, y: y + dy * t };
      };
      const start = edge(a, ax, ay, p1), end = edge(b, bx, by, p2);
      return [{ id: link.id, arrow: link.arrow || 'none', start, end, p1, p2, ax, ay, bx, by,
        d: 'M' + start.x + ',' + start.y + ' C' + p1.x + ',' + p1.y + ' ' + p2.x + ',' + p2.y + ' ' + end.x + ',' + end.y }];
    });
  }
  function specialTreePaths() {
    const paths = [];
    layout.visible.forEach(node => {
      if (node.collapsed) return;
      node.children.forEach(child => {
        if (layoutMode === 'radial') {
          paths.push('M' + (node._rx + node._w / 2) + ',' + (node._ry + node._h / 2) + ' L' + (child._rx + child._w / 2) + ',' + (child._ry + child._h / 2));
        } else {
          const up = layoutMode === 'up';
          const x = node._rx + node._w / 2, y = node._ry + (up ? 0 : node._h);
          const cx = child._rx + child._w / 2, cy = child._ry + (up ? child._h : 0);
          const mid = (y + cy) / 2;
          paths.push('M' + x + ',' + y + ' V' + mid + ' H' + cx + ' V' + cy);
        }
      });
    });
    return paths;
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
        const offsets = sc.map(c => Math.abs(c._ry + c._h / 2 - py)).filter(d => d > 1);
        const r = Math.min(R, seg * 0.6, offsets.length ? Math.min(...offsets) / 2 : R);
        const bx = px + dir * (GAP + seg); // 垂直骨干 x
        const sx = px + dir * GAP;
        // A straight T junction at the parent; round only the outer corners.
        const top = Math.min(py, minCY + r);
        const bottom = Math.max(py, maxCY - r);
        const trunk = 'M' + sx + ',' + py + ' L' + bx + ',' + py +
          ' M' + bx + ',' + top + ' L' + bx + ',' + bottom;
        svg += '<path d="' + trunk + '" fill="none" stroke="' + color + '" stroke-width="2" stroke-linecap="round"/>';
        sc.forEach((child) => {
          const cy = child._ry + child._h / 2;
          const cx = dir === 1 ? child._rx : child._rx + child._w;
          const ex = cx - dir * GAP;
          const corner = cy === minCY && cy < py ? 1 : (cy === maxCY && cy > py ? -1 : 0);
          const vStart = cy + corner * r;
          const cornerX = bx + dir * (corner ? r : 0);
          svg +=
            '<path d="M' + bx + ',' + vStart +
            ' Q' + bx + ',' + cy + ' ' + cornerX + ',' + cy +
            ' L' + ex + ',' + cy +
            '" fill="none" stroke="' + color + '" stroke-width="2" stroke-linecap="round"/>';
        });
      }
    }
    if (['org', 'up', 'radial'].includes(layoutMode)) {
      svg = specialTreePaths().map(d => '<path d="' + d + '" fill="none" stroke="' + theme.rootFill + '" stroke-width="2" stroke-linejoin="round"/>').join('');
    }
    edgesSvg.innerHTML = svg;
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    defs.innerHTML = '<marker id="relation-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1 1L9 5L1 9" fill="none" stroke="' + theme.rootFill + '" stroke-width="1.5"/></marker>';
    edgesSvg.appendChild(defs);
    relationPaths().forEach(link => {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', link.d);
      path.setAttribute('class', 'relation-line');
      path.setAttribute('stroke', theme.rootFill);
      path.setAttribute('stroke-dasharray', '6 5');
      path.setAttribute('stroke-width', selectedRelationId === link.id ? '3' : '2');
      path.setAttribute('fill', 'none');
      if (['forward', 'both'].includes(link.arrow)) path.setAttribute('marker-end', 'url(#relation-arrow)');
      if (['backward', 'both'].includes(link.arrow)) path.setAttribute('marker-start', 'url(#relation-arrow)');
      path.dataset.relationId = link.id;
      path.addEventListener('pointerdown', e => { e.stopPropagation(); });
      path.addEventListener('click', e => { e.stopPropagation(); selectedRelationId = link.id; drawEdges(); });
      path.addEventListener('contextmenu', e => {
        e.preventDefault(); e.stopPropagation();
        selectedRelationId = link.id;
        drawEdges();
        showRelationMenu(link.id, e.clientX, e.clientY);
      });
      edgesSvg.appendChild(path);
      if (selectedRelationId === link.id) {
        for (const [key, point, origin] of [['control1', link.p1, { x: link.ax, y: link.ay }], ['control2', link.p2, { x: link.bx, y: link.by }]]) {
          const guide = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          guide.setAttribute('d', 'M' + origin.x + ',' + origin.y + ' L' + point.x + ',' + point.y);
          guide.setAttribute('class', 'relation-guide');
          edgesSvg.appendChild(guide);
          const handle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
          handle.setAttribute('cx', point.x); handle.setAttribute('cy', point.y); handle.setAttribute('r', '6');
          handle.setAttribute('class', 'relation-handle');
          handle.dataset.control = key;
          handle.addEventListener('pointerdown', e => {
            if (e.button !== 0) return;
            e.preventDefault(); e.stopPropagation();
            relationDrag = { id: link.id, key, control1: { x: link.p1.x - link.ax, y: link.p1.y - link.ay }, control2: { x: link.p2.x - link.bx, y: link.p2.y - link.by }, origin };
          });
          edgesSvg.appendChild(handle);
        }
      }
    });
  }

  function updateStatus() {
    statusCount.textContent = model ? C.countNodes(model.root) + ' 个节点' : '';
  }

  /* ---------------- 编辑 ---------------- */
  function startEdit(id) {
    const node = model.find(id);
    if (!node) return;
    if (editingId) commitEdit();
    selectNode(id);
    const el = nodesLayer.querySelector('.mm-node[data-id="' + escId(id) + '"]');
    if (!el) return;
    editingId = id;
    // 编辑时隐藏节点自身边框/背景，避免与编辑框叠加出"双边框"
    el.classList.add('editing');
    const ta = document.createElement('textarea');
    ta.className = 'mm-editor';
    ta.value = node.text;
    ta.placeholder = node === model.root ? '中心主题' : '输入文本';
    ta.setAttribute('aria-label', '编辑主题文本');
    ta.rows = 1;
    el.appendChild(ta);
    ta.focus();
    ta.select();
    // 输入时实时重新布局：临时更新文字 → layoutTree → 更新所有节点位置（不重建DOM，保持textarea） → 重绘连线
    ta.addEventListener('input', () => {
      const text = ta.value;
      const node = model.find(id);
      if (!node) return;
      const oldText = node.text;
      node.text = text; // 临时更新，仅用于布局计算
      try {
        let newLayout = C.layoutTree(model.root, measure, layoutMode);
        // Browser line wrapping is authoritative for the active textarea.
        el.style.width = node._w + 'px';
        ta.style.height = '0px';
        const editorHeight = ta.scrollHeight + 4;
        ta.style.height = '';
        if (editorHeight > node._h) {
          const editingMeasure = value => {
            const size = C.createMeasure(FONT, 540)(value);
            return value === text ? { width: size.width, height: Math.max(size.height, editorHeight - C.LAYOUT.PAD_Y * 2 - 4) } : size;
          };
          newLayout = C.layoutTree(model.root, editingMeasure, layoutMode);
        }
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
            domEl.style.width = ln._w + 'px';
            domEl.style.height = ln._h + 'px';
            domEl.style.minHeight = ln._h + 'px';
          }
        });
        drawEdges();
      } finally {
        node.text = oldText; // 恢复，commitEdit 时才真正写入 model
      }
    });
    ta.dispatchEvent(new Event('input'));
    ta.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        commitEdit();
        saveNow();
        return;
      }
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
      editingId = null;
      ta.remove();
    }
    editingId = null;
    render();
    selectNode(id);
  }

  function cancelEdit() {
    if (!editingId) return;
    const ta = nodesLayer.querySelector('.mm-editor');
    editingId = null;
    if (ta) ta.remove();
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
    if (key === 'ArrowDown' && idx < order.length - 1) { selectNode(order[idx + 1].id); }
    else if (key === 'ArrowUp' && idx > 0) { selectNode(order[idx - 1].id); }
    else if (key === (sel._side === 'left' ? 'ArrowLeft' : 'ArrowRight')) {
      if (sel.children.length) {
        if (sel.collapsed) {
          model.setCollapsed(sel.id, false);
          render();
          scheduleSave();
        } else {
          selectNode(sel.children[0].id);

        }
      }
    } else if (key === (sel._side === 'left' ? 'ArrowRight' : 'ArrowLeft')) {
      if (sel.children.length && !sel.collapsed) {
        model.setCollapsed(sel.id, true);
        render();
        scheduleSave();
      } else {
        const p = C.findParent(model.root, sel.id);
        if (p) { selectNode(p.id); }
      }
    }
  }

  function onKeyDown(e) {
    // 输入控件内的按键由控件自己处理，避免提交/换行事件冒泡触发全局快捷键
    const tag = e.target && e.target.tagName;
    if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') return;
    if (!model || e.isComposing || editingId || !contextMenu.hidden) return; // 等待文档初始化及输入完成
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
      relationDrag = null;
      selectedRelationId = null;
      drawEdges();
      relationSource = null;
      canvasWrap.classList.remove('linking');
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
    if (e.button !== 0 || spaceHeld) return;
    if (e.target.closest('.mm-editor, .mm-add-btn, .mm-collapse')) return;
    if (editingId) commitEdit();
    const el = e.target.closest('.mm-node');
    if (!el) return;
    if (e.target.closest('.mm-collapse')) return; // 折叠按钮自己处理
    const id = el.dataset.id;
    if (relationSource) {
      const source = relationSource;
      relationSource = null;
      canvasWrap.classList.remove('linking');
      if (model.addRelation(source, id)) { render(); scheduleSave(); toast('已添加虚线关联'); }
      else toast('请选择其他节点，已有的关联不会重复添加');
      return;
    }
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
    if (relationDrag) {
      const rect = canvasWrap.getBoundingClientRect();
      relationDrag[relationDrag.key] = { x: (e.clientX - rect.left - pan.x) / scale - relationDrag.origin.x, y: (e.clientY - rect.top - pan.y) / scale - relationDrag.origin.y };
      drawEdges();
      return;
    }
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
      const canvasRect = canvasWrap.getBoundingClientRect();
      r.left += canvasRect.left;
      r.top += canvasRect.top;
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
      indicator.style.left = (t.rect.left - canvasWrap.getBoundingClientRect().left) + 'px';
      indicator.style.top = (t.rect.top - canvasWrap.getBoundingClientRect().top) + 'px';
      indicator.style.width = t.rect.w + 'px';
      indicator.style.height = t.rect.h + 'px';
    } else {
      indicator.className = 'drop-line';
      indicator.style.left = (t.rect.left - canvasWrap.getBoundingClientRect().left) + 'px';
      indicator.style.width = t.rect.w + 'px';
      indicator.style.height = '3px';
      indicator.style.top = ((t.where === 'before' ? t.rect.top - 1 : t.rect.top + t.rect.h - 1) - canvasWrap.getBoundingClientRect().top) + 'px';
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
    if (relationDrag) {
      const drag = relationDrag;
      relationDrag = null;
      if (model.updateRelation(drag.id, { control1: drag.control1, control2: drag.control2 })) scheduleSave();
      drawEdges();
      return;
    }
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
    vscode.postMessage({ type: 'save', data: JSON.parse(C.serialize(model.data)) });
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
      content: window.MindMapRich && layout.visible.some(node => node.content) ? window.MindMapRich.html(world) : C.htmlExport(model.data),
      defaultName: baseName(),
    });
  }
  function exportPng() {
    if (window.MindMapRich && layout.visible.some(node => node.content?.type === 'mermaid')) {
      window.MindMapRich.prepareImages(layout.visible).then(sendPng).catch(err => toast('PNG 导出失败：' + err.message));
    } else sendPng();
  }
  function sendPng() {
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
    // Include freely moved curve controls in the export canvas.
    const points = relationPaths().flatMap(link => [link.p1, link.p2]);
    const minX = Math.min(0, ...points.map(p => p.x - 30));
    const minY = Math.min(0, ...points.map(p => p.y - 30));
    box.w = Math.max(box.w, ...points.map(p => p.x + 30)) - minX;
    box.h = Math.max(box.h, ...points.map(p => p.y + 30)) - minY;
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
    ctx.translate(-minX * s, -minY * s);
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
      if (!children.length || ['org', 'up', 'radial'].includes(layoutMode)) continue;
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
        const offsets = sc.map(c => Math.abs((c._ry + c._h / 2) * s - py)).filter(d => d > s);
        const r = Math.min(R, seg * 0.6, offsets.length ? Math.min(...offsets) / 2 : R);
        const bx = px + dir * (GAP + seg);
        const sx = px + dir * GAP;
        ctx.beginPath();
        ctx.moveTo(sx, py);
        ctx.lineTo(bx, py);
        ctx.moveTo(bx, Math.min(py, minCY + r));
        ctx.lineTo(bx, Math.max(py, maxCY - r));
        ctx.stroke();
        sc.forEach((child) => {
          const cy = (child._ry + child._h / 2) * s;
          const cx = (dir === 1 ? child._rx : child._rx + child._w) * s;
          const ex = cx - dir * GAP;
          const corner = cy === minCY && cy < py ? 1 : (cy === maxCY && cy > py ? -1 : 0);
          ctx.beginPath();
          ctx.moveTo(bx, cy + corner * r);
          ctx.quadraticCurveTo(bx, cy, bx + dir * (corner ? r : 0), cy);
          ctx.lineTo(ex, cy);
          ctx.stroke();
        });
      }
    }

    ctx.save();
    ctx.scale(s, s);
    ctx.strokeStyle = theme.rootFill;
    ctx.lineWidth = 2;
    if (['org', 'up', 'radial'].includes(layoutMode)) specialTreePaths().forEach(d => ctx.stroke(new Path2D(d)));
    ctx.setLineDash([6, 5]);
    relationPaths().forEach(link => ctx.stroke(new Path2D(link.d)));
    ctx.setLineDash([]);
    const arrow = (tip, control) => {
      const angle = Math.atan2(tip.y - control.y, tip.x - control.x);
      ctx.beginPath();
      ctx.moveTo(tip.x - 10 * Math.cos(angle - 0.45), tip.y - 10 * Math.sin(angle - 0.45));
      ctx.lineTo(tip.x, tip.y);
      ctx.lineTo(tip.x - 10 * Math.cos(angle + 0.45), tip.y - 10 * Math.sin(angle + 0.45));
      ctx.stroke();
    };
    relationPaths().forEach(link => {
      if (['forward', 'both'].includes(link.arrow)) arrow(link.end, link.p2);
      if (['backward', 'both'].includes(link.arrow)) arrow(link.start, link.p1);
    });
    ctx.restore();

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
      if (node.content && window.MindMapRich) {
        window.MindMapRich.draw(ctx, node, x, y, s);
        continue;
      }
      // 普通节点：无背景无边框，只绘制文字
      ctx.fillStyle = isRoot ? theme.rootText : theme.nodeText;
      if (isRoot) {
        ctx.font = '600 ' + FONT.replace('14px', (14 * s) + 'px');
      } else {
        ctx.font = FONT.replace('14px', (14 * s) + 'px');
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
    if (!btn || !model) return;
    if (editingId) commitEdit();
    const action = btn.dataset.action;
    switch (action) {
      case 'import-markdown':
        vscode.postMessage({ type: 'import-markdown' });
        break;
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
      case 'layout-right':
      case 'layout-left':
      case 'layout-compact':
      case 'layout-spacious':
      case 'layout-outline':
      case 'layout-org':
      case 'layout-up':
      case 'layout-radial':
        layoutMode = action.slice('layout-'.length);
        render();
        fitView();
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
    clearTimeout(saveTimer);
    editingId = null;
    selectedId = null;
    isDirty = false;
    fittedOnce = false;
    const data = msg.data ? C.parse(JSON.stringify(msg.data)) : C.defaultData();
    model = new C.MindMapModel(data);
    const textMeasure = C.createMeasure(FONT, 360);
    measure = (text, node) => node && node.content && node._richSize ? node._richSize : textMeasure(text);
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
      try {
        initDoc(msg);
      } catch (err) {
        initDoc({ fileName: msg.fileName, theme: msg.theme, parseError: err.message });
      }
    } else if (msg.type === 'markdown-imported') {
      try {
        const imported = C.markdownImport(msg.content, msg.name);
        if (editingId) commitEdit();
        model.commit();
        model.data = imported;
        selectedId = imported.root.id;
        selectedRelationId = null;
        relationSource = null;
        relationDrag = null;
        render();
        fitView();
        scheduleSave();
        toast('Markdown 已生成思维导图，可撤销恢复导入前内容');
      } catch (err) { toast('导入失败：' + err.message); }
    } else if (msg.type === 'saved') {
      statusText.textContent = '已保存';
    } else if (msg.type === 'request-save') {
      commitEdit();
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

  const relationMenu = document.createElement('div');
  relationMenu.className = 'relation-context-menu';
  relationMenu.hidden = true;
  document.body.appendChild(relationMenu);
  function showRelationMenu(id, x, y) {
    relationMenu.replaceChildren();
    for (const [action, label] of [['forward', '指向目标 →'], ['backward', '指向起点 ←'], ['both', '双向箭头 ↔'], ['none', '无箭头'], ['reset', '恢复直线'], ['delete', '删除关联线']]) {
      const button = document.createElement('button');
      button.textContent = label;
      button.dataset.relationAction = action;
      button.addEventListener('click', () => {
        relationMenu.hidden = true;
        const changed = action === 'delete' ? model.removeRelation(id) : model.updateRelation(id, action === 'reset' ? { control1: null, control2: null } : { arrow: action });
        if (changed) { render(); scheduleSave(); }
      });
      relationMenu.appendChild(button);
    }
    relationMenu.hidden = false;
    const rect = relationMenu.getBoundingClientRect();
    relationMenu.style.left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 4)) + 'px';
    relationMenu.style.top = Math.max(4, Math.min(y, window.innerHeight - rect.height - 4)) + 'px';
  }
  document.addEventListener('pointerdown', e => {
    if (!relationMenu.contains(e.target)) relationMenu.hidden = true;
  });
  window.addEventListener('keydown', e => { if (e.key === 'Escape') relationMenu.hidden = true; });

  /* ---------------- 节点右键菜单 ---------------- */
  const contextMenu = document.createElement('div');
  contextMenu.className = 'node-context-menu';
  contextMenu.setAttribute('role', 'menu');
  contextMenu.hidden = true;
  document.body.appendChild(contextMenu);
  let contextNodeId = null;
  function closeContextMenu() {
    contextMenu.hidden = true;
    contextNodeId = null;
  }
  nodesLayer.addEventListener('contextmenu', e => {
    const el = e.target.closest('.mm-node');
    if (!el || !model) return;
    e.preventDefault();
    const id = el.dataset.id;
    if (editingId) commitEdit();
    cancelDrag();
    selectNode(id);
    contextNodeId = id;
    contextMenu.replaceChildren();
    const parent = C.findParent(model.root, id);
    for (const [action, label, disabled] of [
      ['promote', '提升层级', !parent || parent === model.root],
      ['delete', '删除', !parent],
      ['add-child', '增加下一级', false],
      ['relation', '添加关联线', false],
    ]) {
      const button = document.createElement('button');
      button.textContent = label;
      button.dataset.contextAction = action;
      button.disabled = disabled;
      button.setAttribute('role', 'menuitem');
      contextMenu.appendChild(button);
    }
    contextMenu.hidden = false;
    const rect = contextMenu.getBoundingClientRect();
    contextMenu.style.left = Math.max(4, Math.min(e.clientX, window.innerWidth - rect.width - 4)) + 'px';
    contextMenu.style.top = Math.max(4, Math.min(e.clientY, window.innerHeight - rect.height - 4)) + 'px';
    contextMenu.querySelector('button:not(:disabled)').focus();
  });
  contextMenu.addEventListener('click', e => {
    const button = e.target.closest('button');
    if (!button || button.disabled || !contextNodeId) return;
    const id = contextNodeId;
    closeContextMenu();
    let changed = false;
    let child = null;
    switch (button.dataset.contextAction) {
      case 'relation':
        relationSource = id;
        canvasWrap.classList.add('linking');
        toast('点击目标节点添加虚线关联，Esc 取消');
        break;
      case 'promote': changed = model.promote(id); break;
      case 'delete': {
        const parent = C.findParent(model.root, id);
        changed = model.removeNode(id);
        if (changed) selectedId = parent.id;
        break;
      }
      case 'add-child': child = model.addChild(id, ''); changed = !!child; break;
    }
    if (changed) {
      render();
      scheduleSave();
      if (child) startEdit(child.id);
    }
  });
  contextMenu.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeContextMenu();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      const buttons = Array.from(contextMenu.querySelectorAll('button:not(:disabled)'));
      const index = buttons.indexOf(document.activeElement);
      buttons[(index + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length].focus();
    }
  });
  document.addEventListener('pointerdown', e => {
    if (!contextMenu.contains(e.target)) closeContextMenu();
  });
  window.addEventListener('blur', closeContextMenu);
  window.addEventListener('resize', closeContextMenu);
  canvasWrap.addEventListener('wheel', closeContextMenu);

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
  window.addEventListener('pointercancel', () => {
    relationDrag = null;
    if (model) drawEdges();
    cancelDrag();
    panState = null;
    canvasWrap.classList.remove('panning');
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

  // Small SVG previews keep every layout discoverable in the shape picker.
  document.querySelectorAll('#layout-menu [data-action]').forEach(item => {
    const label = item.textContent;
    const mode = item.dataset.action.slice(7);
    const previews = {
      standard: 'M35 25H18V10H5M18 25V40H5M35 25H52V10H65M52 25V40H65',
      right: 'M8 25H28V8H60M28 25H60M28 25V42H60',
      left: 'M62 25H42V8H10M42 25H10M42 25V42H10',
      compact: 'M8 25H24V15H55M24 25H55M24 25V35H55',
      spacious: 'M5 25H24V5H65M24 25H65M24 25V45H65',
      outline: 'M10 5V45M10 15H35M10 30H35M35 30V42H60',
      org: 'M35 5V22M10 40V22H60V40M35 22V40',
      up: 'M35 45V28M10 10V28H60V10M35 28V10',
      radial: 'M35 25L15 8M35 25L55 8M35 25L62 35M35 25L35 45M35 25L8 35',
    };
    item.textContent = '';
    item.title = label;
    item.setAttribute('aria-label', label);
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 70 50');
    icon.innerHTML = '<path d="' + previews[mode] + '" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><rect x="28" y="20" width="14" height="9" rx="3" fill="currentColor"/>';
    item.appendChild(icon);
    const caption = document.createElement('span');
    caption.textContent = label;
    item.appendChild(caption);
  });

  buildThemeMenu();
  applyTheme();
  vscode.postMessage({ type: 'ready' });
})();

