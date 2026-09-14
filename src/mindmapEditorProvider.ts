import * as vscode from 'vscode';
import * as path from 'path';

export const MINDMAP_VIEW_TYPE = 'mindmap.editor';

interface ExportMessage {
  type: string;
  format?: 'markdown' | 'html' | 'png';
  defaultName?: string;
  content?: string;
  pngBase64?: string;
  data?: unknown;
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

  constructor(private readonly _context: vscode.ExtensionContext) {}

  async openCustomDocument(uri: vscode.Uri): Promise<MindMapDocument> {
    return MindMapDocument.create(uri);
  }

  async resolveCustomEditor(
    document: MindMapDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    this._panels.set(document, webviewPanel);
    webviewPanel.onDidDispose(() => {
      this._panels.delete(document);
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
      case 'ready': {
        // 向 Webview 下发文档数据（数据由 Webview 持有为权威状态，扩展侧负责落盘）
        const themeName = vscode.workspace.getConfiguration('mindmap').get<string>('defaultTheme', 'feishu');
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
      case 'export': {
        await this._export(document, msg);
        return;
      }
      default:
        return;
    }
  }

  private async _export(document: MindMapDocument, msg: ExportMessage): Promise<void> {
    const format = msg.format ?? 'markdown';
    const extMap: Record<string, string> = { markdown: 'md', html: 'html', png: 'png' };
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
      const themeName = vscode.workspace.getConfiguration('mindmap').get<string>('defaultTheme', 'feishu');
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
    const coreUri = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'media', 'core.js'));
    const appUri = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'media', 'mindmap.js'));
    const csp = webview.cspSource;

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src ${csp}; script-src ${csp}; img-src ${csp} data:; font-src ${csp};" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>思维导图</title>
  <link rel="stylesheet" href="${cssUri}" />
</head>
<body>
  <div id="toolbar">
    <button class="tb-btn primary" data-action="add-child" title="为选中节点添加子主题（Tab）">＋ 子主题</button>
    <span class="tb-sep"></span>
    <button class="tb-btn" data-action="undo" title="撤销（Ctrl+Z）">撤销</button>
    <button class="tb-btn" data-action="redo" title="重做（Ctrl+Y）">重做</button>
    <span class="tb-sep"></span>
    <button class="tb-btn icon" data-action="zoom-out" title="缩小">－</button>
    <span class="tb-zoom" id="zoom-label">100%</span>
    <button class="tb-btn icon" data-action="zoom-in" title="放大">＋</button>
    <button class="tb-btn" data-action="fit" title="适应窗口">适应</button>
    <span class="tb-sep"></span>
    <div class="tb-dropdown">
      <button class="tb-btn" data-action="layout-toggle">形状 ▾</button>
      <div class="tb-menu" id="layout-menu">
        <div class="tb-menu-item" data-action="layout-standard">标准（左右分布）</div>
        <div class="tb-menu-item" data-action="layout-right">右向树</div>
        <div class="tb-menu-item" data-action="layout-left">左向树</div>
      </div>
    </div>
    <div class="tb-dropdown">
      <button class="tb-btn" data-action="theme-toggle">主题 ▾</button>
      <div class="tb-menu" id="theme-menu"></div>
    </div>
    <div class="tb-dropdown">
      <button class="tb-btn" data-action="export-toggle">导出 ▾</button>
      <div class="tb-menu" id="export-menu">
        <div class="tb-menu-item" data-action="export-markdown">导出为 Markdown</div>
        <div class="tb-menu-item" data-action="export-html">导出为 HTML</div>
        <div class="tb-menu-item" data-action="export-png">导出为 PNG 图片</div>
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
  <div id="hintbar">Tab 子主题 · Enter 同级 · Shift+Tab 提升层级 · F2 编辑 · Del 删除 · 方向键导航 · 滚轮缩放 / 拖拽平移 · 拖节点调整结构</div>
  <div id="toast"></div>

  <script src="${coreUri}"></script>
  <script src="${appUri}"></script>
</body>
</html>`;
  }
}
