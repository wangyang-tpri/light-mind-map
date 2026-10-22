import * as vscode from 'vscode';
import * as path from 'path';

export const MINDMAP_VIEW_TYPE = 'mindsprout.editor';

interface ExportMessage {
  type: string;
  format?: 'markdown' | 'html' | 'png' | 'svg';
  defaultName?: string;
  content?: string;
  pngBase64?: string;
  data?: unknown;
  src?: string;
  requestId?: string;
}

/**
 * 思维导图文档：负责读取 / 持有 / 序列化 .mindmap 文件数据。
 */
class MindMapDocument implements vscode.CustomDocument {
  readonly uri: vscode.Uri;
  data: unknown = null;
  parseError: string | null = null;

  private readonly _onDidDispose = new vscode.EventEmitter<void>();
  readonly onDidDispose = this._onDidDispose.event;

  static async create(uri: vscode.Uri): Promise<MindMapDocument> {
    const doc = new MindMapDocument(uri);
    await doc.reload();
    return doc;
  }

  private constructor(uri: vscode.Uri) {
    this.uri = uri;
  }

  /** 从磁盘重新读取文件（失败时保留空白画布并记录错误）。 */
  async reload(): Promise<void> {
    this.parseError = null;
    try {
      const bytes = await vscode.workspace.fs.readFile(this.uri);
      const text = Buffer.from(bytes).toString('utf8');
      const obj = JSON.parse(text) as unknown;
      if (!obj || typeof obj !== 'object' || !(obj as { root?: unknown }).root) {
        throw new Error('缺少 root 节点');
      }
      this.data = obj;
    } catch (err) {
      this.data = null;
      this.parseError = err instanceof Error ? err.message : String(err);
    }
  }

  serialize(): string {
    return JSON.stringify(this.data, null, 2);
  }

  /** Save As 后切换文档指向的新 URI。 */
  setUri(uri: vscode.Uri): void {
    (this as { uri: vscode.Uri }).uri = uri;
  }

  dispose(): void {
    this._onDidDispose.fire();
  }
}

export class MindMapEditorProvider implements vscode.CustomEditorProvider<MindMapDocument> {
  static readonly viewType = MINDMAP_VIEW_TYPE;

  private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<
    vscode.CustomDocumentEditEvent<MindMapDocument>
  >();
  readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

  private readonly _panels = new Map<MindMapDocument, vscode.WebviewPanel>();
  private readonly _imageBases = new Map<vscode.WebviewPanel, vscode.Uri>();
  private readonly _markdownPreviews = new Map<string, vscode.WebviewPanel>();

  constructor(private readonly _context: vscode.ExtensionContext) {}

  openMarkdownPreview(source: vscode.TextDocument, sourceColumn: vscode.ViewColumn = vscode.ViewColumn.One): void {
    // 使用源编辑器右侧的明确分组，避免重复执行时相对当前预览继续分屏。
    const previewColumn = Math.min(sourceColumn + 1, vscode.ViewColumn.Nine);
    const key = source.uri.toString();
    const existing = this._markdownPreviews.get(key);
    if (existing) { existing.reveal(previewColumn, true); existing.webview.html = this._getHtml(existing.webview); return; }
    const name = path.basename(source.uri.fsPath) || 'Markdown';
    const panel = vscode.window.createWebviewPanel('mindsprout.markdownPreview', `${name} · 知枝预览`, { viewColumn: previewColumn, preserveFocus: true }, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(this._context.extensionUri, 'media')],
    });
    this._markdownPreviews.set(key, panel);
    this._imageBases.set(panel, source.uri);
    let ready = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => panel.webview.postMessage({
      type: 'init', markdown: source.getText(), readOnly: true, fileName: name,
      theme: vscode.workspace.getConfiguration('mindmap').get<string>('defaultTheme', 'lightMap'),
    });
    const messages = panel.webview.onDidReceiveMessage((msg: ExportMessage) => {
      if (msg.type === 'ready') { ready = true; void update(); }
      else if (msg.type === 'resolve-image') void this._resolveImage(panel, msg);
      else if (msg.type === 'export') void this._export({uri: source.uri}, msg);
    });
    const changes = vscode.workspace.onDidChangeTextDocument(event => {
      if (!ready || event.document.uri.toString() !== key) return;
      clearTimeout(timer);
      timer = setTimeout(() => { void update(); }, 200);
    });
    panel.onDidDispose(() => {
      clearTimeout(timer); messages.dispose(); changes.dispose();
      this._markdownPreviews.delete(key);
      this._imageBases.delete(panel);
    });
    panel.webview.html = this._getHtml(panel.webview);
  }

  async openCustomDocument(uri: vscode.Uri): Promise<MindMapDocument> {
    return MindMapDocument.create(uri);
  }

  async resolveCustomEditor(
    document: MindMapDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    this._panels.set(document, webviewPanel);
    this._imageBases.set(webviewPanel, document.uri);
    webviewPanel.onDidDispose(() => {
      this._panels.delete(document);
      this._imageBases.delete(webviewPanel);
    });

    webviewPanel.title = path.basename(document.uri.fsPath);
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._context.extensionUri, 'media')],
    };
    webviewPanel.webview.html = this._getHtml(webviewPanel.webview);

    webviewPanel.webview.onDidReceiveMessage(
      (msg: ExportMessage) => {
        void this._handleMessage(document, webviewPanel, msg);
      },
      undefined,
      this._context.subscriptions
    );
  }

  private async _handleMessage(
    document: MindMapDocument,
    panel: vscode.WebviewPanel,
    msg: ExportMessage
  ): Promise<void> {
    switch (msg.type) {
      case 'resolve-image': await this._resolveImage(panel, msg); return;
      case 'ready': {
        // 向 Webview 下发文档数据（数据由 Webview 持有为权威状态，扩展侧负责落盘）
        const themeName = vscode.workspace.getConfiguration('mindmap').get<string>('defaultTheme', 'lightMap');
        panel.webview.postMessage({
          type: 'init',
          data: document.data,
          parseError: document.parseError,
          fileName: path.basename(document.uri.fsPath),
          theme: themeName,
        });
        return;
      }
      case 'save': {
        try {
          document.data = msg.data;
          await vscode.workspace.fs.writeFile(
            document.uri,
            Buffer.from(JSON.stringify(document.data, null, 2), 'utf8')
          );
          this._onDidChangeCustomDocument.fire({
            document,
            undo: () => undefined,
            redo: () => undefined,
            label: '编辑思维导图',
          });
          panel.webview.postMessage({ type: 'saved' });
        } catch (err) {
          panel.webview.postMessage({
            type: 'error',
            message: `保存失败：${err instanceof Error ? err.message : String(err)}`,
          });
        }
        return;
      }
      case 'import-markdown': {
        const files = await vscode.window.showOpenDialog({
          canSelectMany: false,
          filters: { Markdown: ['md', 'markdown'] },
          openLabel: '导入并生成思维导图',
        });
        if (!files?.length) return;
        try {
          const bytes = await vscode.workspace.fs.readFile(files[0]);
          this._imageBases.set(panel, files[0]);
          await panel.webview.postMessage({
            type: 'markdown-imported',
            content: Buffer.from(bytes).toString('utf8'),
            name: path.basename(files[0].fsPath, path.extname(files[0].fsPath)),
          });
        } catch (err) {
          panel.webview.postMessage({ type: 'error', message: `导入失败：${err instanceof Error ? err.message : String(err)}` });
        }
        return;
      }
      case 'export': {
        await this._export(document, msg);
        return;
      }
      default:
        return;
    }
  }

  private async _resolveImage(panel: vscode.WebviewPanel, msg: ExportMessage): Promise<void> {
    const source = msg.src || '';
    try {
      if (!source || source.length > 8192) throw new Error('图片路径无效');
      let bytes: Uint8Array;
      let extension = path.extname(source.split(/[?#]/)[0]).toLowerCase();
      let mime = '';
      if (/^https?:\/\//i.test(source)) {
        const response = await fetch(source, { signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error('图片下载失败');
        if (Number(response.headers.get('content-length')) > 20 * 1024 * 1024) throw new Error('图片超过 20 MB');
        mime = (response.headers.get('content-type') || '').split(';')[0];
        bytes = new Uint8Array(await response.arrayBuffer());
      } else {
        const base = this._imageBases.get(panel);
        if (!base) throw new Error('缺少图片所在目录');
        if (/^[a-z][a-z0-9+.-]*:/i.test(source) && !/^file:/i.test(source) && !/^[a-z]:[\\/]/i.test(source)) throw new Error('不支持的图片地址');
        const uri = /^file:/i.test(source) ? vscode.Uri.parse(source) : path.isAbsolute(source) ? vscode.Uri.file(source) : vscode.Uri.joinPath(base, '..', decodeURIComponent(source.split(/[?#]/)[0]));
        extension = path.extname(uri.fsPath).toLowerCase();
        bytes = await vscode.workspace.fs.readFile(uri);
      }
      const types: Record<string, string> = { '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.gif':'image/gif', '.webp':'image/webp', '.svg':'image/svg+xml', '.bmp':'image/bmp', '.avif':'image/avif' };
      mime = /^image\/(png|jpeg|gif|webp|svg\+xml|bmp|avif)$/.test(mime) ? mime : types[extension];
      if (!mime || bytes.length > 20 * 1024 * 1024) throw new Error('不支持的图片格式或图片超过 20 MB');
      await panel.webview.postMessage({ type:'image-resolved', requestId:msg.requestId, src:source, dataUri:'data:' + mime + ';base64,' + Buffer.from(bytes).toString('base64') });
    } catch (error) {
      await panel.webview.postMessage({ type:'image-resolved', requestId:msg.requestId, src:source, error:error instanceof Error ? error.message : '图片加载失败' });
    }
  }

  private async _export(document: {uri: vscode.Uri}, msg: ExportMessage): Promise<void> {
    const format = msg.format ?? 'markdown';
    const extMap: Record<string, string> = { markdown: 'md', html: 'html', png: 'png', svg: 'svg' };
    const ext = extMap[format] ?? 'md';
    const base = path.basename(document.uri.fsPath, path.extname(document.uri.fsPath));
    const defaultName = `${msg.defaultName && msg.defaultName.trim() ? msg.defaultName : base}.${ext}`;

    const dir = path.dirname(document.uri.fsPath);
    const picked = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(dir, defaultName)),
      filters: { [format.toUpperCase()]: [ext] },
      saveLabel: '导出',
    });
    if (!picked) {
      return;
    }

    try {
      if (format === 'png') {
        if (!msg.pngBase64) {
          throw new Error('未收到 PNG 数据');
        }
        await vscode.workspace.fs.writeFile(picked, Buffer.from(msg.pngBase64, 'base64'));
      } else {
        await vscode.workspace.fs.writeFile(picked, Buffer.from(msg.content ?? '', 'utf8'));
      }
      void vscode.window.showInformationMessage(`已导出：${path.basename(picked.fsPath)}`);
    } catch (err) {
      void vscode.window.showErrorMessage(`导出失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async revertCustomDocument(document: MindMapDocument, _cancelToken: vscode.CancellationToken): Promise<void> {
    await document.reload();
    const panel = this._panels.get(document);
    if (panel) {
      const themeName = vscode.workspace.getConfiguration('mindmap').get<string>('defaultTheme', 'lightMap');
      panel.webview.postMessage({
        type: 'init',
        data: document.data,
        parseError: document.parseError,
        fileName: path.basename(document.uri.fsPath),
        theme: themeName,
      });
    }
  }

  /**
   * Ctrl+S：数据由 Webview 自动保存（防抖）已写盘，这里直接视为完成。
   * 若存在尚未落盘的改动，主动通知 Webview 立即保存。
   */
  async saveCustomDocument(document: MindMapDocument, _token: vscode.CancellationToken): Promise<void> {
    const panel = this._panels.get(document);
    if (panel) {
      panel.webview.postMessage({ type: 'request-save' });
    }
  }

  /** 另存为：将当前数据写入目标路径，并让文档指向新 URI。 */
  async saveCustomDocumentAs(
    document: MindMapDocument,
    destination: vscode.Uri,
    _token: vscode.CancellationToken
  ): Promise<void> {
    if (document.data !== null) {
      await vscode.workspace.fs.writeFile(destination, Buffer.from(JSON.stringify(document.data, null, 2), 'utf8'));
    }
    document.setUri(destination);
    const panel = this._panels.get(document);
    if (panel) {
      panel.title = path.basename(destination.fsPath);
      panel.webview.postMessage({ type: 'saved' });
    }
  }

  async backupCustomDocument(
    document: MindMapDocument,
    context: vscode.CustomDocumentBackupContext
  ): Promise<vscode.CustomDocumentBackup> {
    if (document.data) {
      await vscode.workspace.fs.writeFile(
        context.destination,
        Buffer.from(JSON.stringify(document.data, null, 2), 'utf8')
      );
    } else {
      await vscode.workspace.fs.writeFile(context.destination, Buffer.from('', 'utf8'));
    }
    return {
      id: context.destination.toString(),
      delete: () => vscode.workspace.fs.delete(context.destination),
    };
  }

  private _getHtml(webview: vscode.Webview): string {
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'media', 'style.css'));
    const appUri = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'media', 'mindsprout.js'));
    const mermaidUri = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'media', 'vendor', 'mermaid.min.js'));
    const bootstrapUri = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'media', 'bootstrap.js'));
    const csp = webview.cspSource;

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src ${csp}; img-src ${csp} data:; font-src ${csp};" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>知枝 · MindSprout</title>
  <link rel="stylesheet" href="${cssUri}" />
</head>
<body>
  <div id="toolbar" role="toolbar" aria-label="知枝工具栏" aria-orientation="vertical">
  <button class="tb-btn primary tb-tool" data-action="add-child" title="为选中节点添加子主题（Tab）" aria-label="＋ 子主题"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM17 13v8m-4-4h8" /></svg><span class="tool-label">＋ 子主题</span></button>
    <button class="tb-btn tb-tool" data-action="import-markdown" title="导入 Markdown 标题和列表，支持撤销" aria-label="导入 Markdown"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H5v18h14V8zM14 3v5h5M8 13l4 4 4-4m-4-3v7" /></svg><span class="tool-label">导入 Markdown</span></button>
    <button id="btn-toggle-all-nodes" class="tb-btn tb-tool" data-action="toggle-all-nodes" title="展开全部节点" disabled aria-label="节点一键展开"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h6v6H4zM14 14h6v6h-6zM14 4h6v6h-6zM4 14h6v6H4z" /></svg><span class="tool-label">节点一键展开</span></button>
    <span class="tb-sep"></span>
    <button id="btn-undo" class="tb-btn tb-tool" data-action="undo" title="撤销（Ctrl+Z）" aria-label="撤销"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5L4 10l5 5M4 10h10a6 6 0 0 1 0 12" /></svg><span class="tool-label">撤销</span></button>
    <button id="btn-redo" class="tb-btn tb-tool" data-action="redo" title="重做（Ctrl+Y）" aria-label="重做"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l5 5-5 5M20 10H10a6 6 0 0 0 0 12" /></svg><span class="tool-label">重做</span></button>
    <span class="tb-sep"></span>
    <button class="tb-btn icon tb-tool" data-action="zoom-out" title="缩小" aria-label="－"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 21l-5-5M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0M7 10h6" /></svg><span class="tool-label">－</span></button>
    <button class="tb-btn tb-zoom tb-tool" id="zoom-label" data-action="zoom-reset" title="恢复 100% 清晰显示" aria-label="100%"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8V3h5M16 3h5v5M21 16v5h-5M8 21H3v-5M8 8h8v8H8z" /></svg><span class="tool-label">100%</span></button>
    <button class="tb-btn icon tb-tool" data-action="zoom-in" title="放大" aria-label="＋"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 21l-5-5M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0M7 10h6m-3-3v6" /></svg><span class="tool-label">＋</span></button>
    <button class="tb-btn tb-tool" data-action="fit" title="适应窗口" aria-label="适应"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9V3h6M15 3h6v6M21 15v6h-6M9 21H3v-6M8 8h8v8H8z" /></svg><span class="tool-label">适应</span></button>
    <span class="tb-sep"></span>
    <div class="tb-dropdown">
      <button class="tb-btn tb-tool" data-action="layout-toggle" aria-label="形状"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6v5H9zM2 16h6v5H2zM16 16h6v5h-6zM12 8v4M5 16v-4h14v4" /></svg><span class="tool-label">形状</span></button>
      <div class="tb-menu" id="layout-menu">
        <div class="tb-menu-item" data-action="layout-standard">标准（左右分布）</div>
        <div class="tb-menu-item" data-action="layout-right">右向树</div>
        <div class="tb-menu-item" data-action="layout-left">左向树</div>
        <div class="tb-menu-item" data-action="layout-compact">紧凑右向树</div>
        <div class="tb-menu-item" data-action="layout-spacious">宽松右向树</div>
        <div class="tb-menu-item" data-action="layout-outline">目录结构</div>
        <div class="tb-menu-item" data-action="layout-org">向下组织图</div>
        <div class="tb-menu-item" data-action="layout-up">向上组织图</div>
      </div>
    </div>
    <div class="tb-dropdown">
      <button class="tb-btn tb-tool" data-action="style-toggle" aria-label="样式"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20L17 7l3 3L7 23zM14 4l3-3 6 6-3 3M3 3h7M6.5 3v10" /></svg><span class="tool-label">样式</span></button>
      <div class="tb-menu" id="style-menu">
        <label class="style-field">画布背景 <input type="text" id="canvas-color" aria-label="画布背景颜色" maxlength="7" placeholder="#ffffff" spellcheck="false" /></label>
        <div class="color-palette" data-color-palette="canvas-color" aria-label="画布背景调色板"></div>
        <button class="tb-btn" data-action="canvas-reset">恢复主题背景</button>
        <div class="style-hint" id="style-hint">请先选中节点</div>
        <label class="style-field">分支线条 <input type="text" id="line-color" aria-label="分支线条颜色" maxlength="7" placeholder="#3370ff" spellcheck="false" /></label>
        <div class="color-palette" data-color-palette="line-color" aria-label="分支线条调色板"></div>
        <label class="style-field">文字颜色 <input type="text" id="text-color" aria-label="文字颜色" maxlength="7" placeholder="#1f2329" spellcheck="false" /></label>
        <div class="color-palette" data-color-palette="text-color" aria-label="文字调色板"></div>
        <label class="style-field">文字粗细 <select id="font-weight" aria-label="文字粗细"><option value="400">常规</option><option value="600">半粗</option><option value="700">加粗</option></select></label>
        <button class="tb-btn" data-action="style-reset">恢复继承父级样式</button>
      </div>
    </div>
    <div class="tb-dropdown">
      <button class="tb-btn tb-tool" data-action="theme-toggle" aria-label="主题"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 1 0 0 18h2a2 2 0 0 0 1-4 2 2 0 0 1 1-4h2a3 3 0 0 0 3-3c0-4-4-7-9-7M7 9h.01M10 6h.01M15 6h.01M18 9h.01" /></svg><span class="tool-label">主题</span></button>
      <div class="tb-menu" id="theme-menu"></div>
    </div>
    <div class="tb-dropdown">
      <button class="tb-btn tb-tool" data-action="export-toggle" aria-label="导出"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V3m-4 4 4-4 4 4M5 13v8h14v-8" /></svg><span class="tool-label">导出</span></button>
      <div class="tb-menu" id="export-menu">
        <div class="tb-menu-item" data-action="export-svg">导出为 SVG（无损放大）</div>
        <div class="tb-menu-item" data-action="export-html">导出为 HTML</div>
        <div class="tb-menu-item" data-action="export-png">导出为高清 PNG 图片</div>
      </div>
    </div>
  </div>

  <div id="canvas-wrap">
    <div id="world">
      <svg id="edges" width="0" height="0"></svg>
      <div id="nodes"></div>
    </div>
    <div id="drag-indicator"></div>
  </div>

  <div id="statusbar"><span id="status-text">就绪</span><span id="status-count"></span></div>
  <div id="hintbar">Tab 子主题 · Enter 同级 · Shift+Tab 提升层级 · F2 编辑 · Del 删除 · 方向键导航 · Ctrl+滚轮缩放 / 拖拽平移 · 拖节点调整结构</div>
  <div id="toast"></div>

  <script src="${bootstrapUri}"></script>
  <script src="${mermaidUri}"></script>
  <script src="${appUri}"></script>
</body>
</html>`;
  }
}
