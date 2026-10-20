(function () {
  'use strict';
  const cache = new Map();
  let sequence = 0;
  if (window.mermaid) window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, flowchart: { htmlLabels: false }, theme: 'neutral' });
  const keyOf = node => JSON.stringify([node.content, node.text]);
  function tableRows(source) {
    return source.trim().split('\n').filter((_, i) => i !== 1).map(line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|')));
  }
  function element(node) {
    const box = document.createElement('div');
    box.className = 'mm-rich mm-rich-' + node.content.type;
    if (node.content.type === 'table') {
      const table = document.createElement('table');
      tableRows(node.text).forEach((cells, i) => {
        const row = document.createElement('tr');
        cells.forEach(value => { const cell = document.createElement(i ? 'td' : 'th'); cell.textContent = value; row.appendChild(cell); });
        table.appendChild(row);
      });
      box.appendChild(table);
    } else if (node.content.type === 'mermaid' && cache.get(keyOf(node))?.svg) {
      box.innerHTML = cache.get(keyOf(node)).svg;
    } else {
      const label = document.createElement('div');
      label.className = 'mm-code-label';
      label.textContent = node.content.type === 'mermaid' ? (cache.get(keyOf(node))?.error ? 'Mermaid 语法错误 · 双击修改源码' : 'Mermaid 图表加载中…') : (node.content.language || '代码');
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = node.text;
      pre.appendChild(code); box.append(label, pre);
    }
    return box;
  }
  function prepare(root, changed) {
    const visit = node => {
      if (node.content) {
        const key = keyOf(node);
        if (!cache.has(key)) {
          const record = {};
          cache.set(key, record);
          if (node.content.type === 'mermaid') {
            if (window.mermaid) {
              window.mermaid.render('mm-diagram-' + (++sequence), node.text).then(result => {
                record.svg = result.svg;
                record.ready = new Promise(resolve => {
                  const image = new Image();
                  image.onload = () => { record.image = image; resolve(); };
                  image.onerror = () => resolve();
                  image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(result.svg);
                });
                changed();
              }).catch(() => { record.error = true; changed(); });
            } else record.error = true;
          }
        }
        const probe = element(node);
        probe.classList.add('mm-rich-probe');
        document.body.appendChild(probe);
        const rect = probe.getBoundingClientRect();
        node._richSize = { width: Math.max(160, Math.ceil(rect.width)), height: Math.max(44, Math.ceil(rect.height)) };
        probe.remove();
      }
      if (!node.collapsed) node.children.forEach(visit);
    };
    visit(root);
  }
  function svg(node) { return cache.get(keyOf(node))?.svg; }
  function html(world) {
    const clone = world.cloneNode(true);
    clone.style.transform = 'none'; clone.style.zoom = '1';
    clone.querySelectorAll('.mm-collapse,.mm-add-btn,.mm-editor,.relation-handle,.relation-guide').forEach(el => el.remove());
    clone.querySelectorAll('.mm-node').forEach(el => el.classList.remove('selected', 'editing'));
    const css = Array.from(document.styleSheets).flatMap(sheet => {
      try { return Array.from(sheet.cssRules, rule => rule.cssText); } catch (_) { return []; }
    }).join('\n');
    return '<!DOCTYPE html><html lang="zh-CN"><meta charset="utf-8"><title>思维导图</title><style>' + css + '\nhtml,body{overflow:auto;min-height:100%;}#world{position:relative;margin:40px;}#edges{pointer-events:none;}</style><body style="' + document.body.style.cssText + '">' + clone.outerHTML + '</body></html>';
  }
  function prepareImages(nodes) { return Promise.all(nodes.map(node => cache.get(keyOf(node))?.ready)); }
  function draw(ctx, node, x, y, scale) {
    const probe = element(node);
    probe.classList.add('mm-rich-probe');
    document.body.appendChild(probe);
    const box = probe.getBoundingClientRect();
    ctx.save();
    ctx.translate(x + 5 * scale, y + 7 * scale);
    ctx.scale(scale, scale);
    ctx.textBaseline = 'top'; ctx.textAlign = 'left';
    const write = (text, left, top, width, font, color) => {
      ctx.font = font; ctx.fillStyle = color;
      let row = '', line = 0;
      for (const ch of text) {
        if (ch === '\n' || (row && ctx.measureText(row + ch).width > width)) {
          ctx.fillText(row, left, top + line++ * 20); row = '';
        }
        if (ch !== '\n') row += ch;
      }
      ctx.fillText(row, left, top + line * 20);
    };
    const image = cache.get(keyOf(node))?.image;
    if (node.content.type === 'mermaid' && image) ctx.drawImage(image, 0, 0, box.width, box.height);
    else if (node.content.type === 'table') {
      probe.querySelectorAll('th,td').forEach(cell => {
        const r = cell.getBoundingClientRect(), left = r.left - box.left, top = r.top - box.top;
        ctx.fillStyle = cell.tagName === 'TH' ? '#edf3ff' : '#ffffff';
        ctx.fillRect(left, top, r.width, r.height);
        ctx.strokeStyle = '#dfe3e9'; ctx.lineWidth = 1; ctx.strokeRect(left, top, r.width, r.height);
        write(cell.textContent, left + 10, top + 7, r.width - 20, (cell.tagName === 'TH' ? '600 ' : '') + '14px sans-serif', '#1f2329');
      });
    } else {
      ctx.fillStyle = '#f3f5f8'; ctx.fillRect(0, 0, box.width, box.height);
      write(node.content.language || '代码', 10, 2, box.width - 20, '11px sans-serif', '#8f959e');
      write(node.text, 12, 28, box.width - 24, '13px Consolas, monospace', '#1f2329');
    }
    ctx.restore(); probe.remove();
  }
  window.MindMapRich = { element, prepare, tableRows, svg, prepareImages, draw, html };
})();
