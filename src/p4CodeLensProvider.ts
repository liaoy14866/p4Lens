import * as vscode from 'vscode';
import { findP4Config } from './p4Config';
import { runP4Annotate, runP4Describe, runP4Diff, runP4Opened, ChangelistDetails, LineAnnotation } from './p4Command';
import { mergeAnnotationsForCurrentDocument } from './p4AnnotationMerge';
import { P4SymbolCodeLensFeature } from './p4SymbolCodeLens';

export class P4CodeLensProvider implements vscode.HoverProvider, vscode.CodeLensProvider {
  private annotations: Map<string, Map<number, LineAnnotation>> = new Map();
  private changeDetails: Map<string, ChangelistDetails> = new Map();
  private inFlightDescribe: Map<string, Promise<ChangelistDetails | null>> = new Map();
  private p4ConfigByFile: Map<string, Awaited<ReturnType<typeof findP4Config>>> = new Map();
  private fileOpenStateByPath: Map<string, boolean> = new Map();
  private renderRequestId = 0;
  private showDecoration = true;
  private readonly codeLensChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.codeLensChangeEmitter.event;
  private readonly symbolCodeLensFeature: P4SymbolCodeLensFeature;
  private readonly decorationType = vscode.window.createTextEditorDecorationType({
    after: {
      contentText: '',
      margin: '0 0 0 48px',
      color: new vscode.ThemeColor('disabledForeground'),
      fontStyle: 'italic',
    },
    isWholeLine: false,
  });

  constructor() {
    this.symbolCodeLensFeature = new P4SymbolCodeLensFeature({
      getAnnotations: (document) => this.getOrFetchAnnotations(document),
      escapeMarkdown: (text) => this.escapeMarkdown(text),
    });
  }

  async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    return this.symbolCodeLensFeature.provideCodeLenses(document);
  }

  /**
   * Update decoration for selected line only
   */
  async updateDecorationsForSelection(editor: vscode.TextEditor): Promise<void> {
    const requestId = ++this.renderRequestId;
    const filePath = editor.document.uri.fsPath;
    const selectedLine = editor.selection.active.line + 1;

    // Get or fetch annotations
    const annotations = await this.getOrFetchAnnotations(editor.document);
    if (requestId !== this.renderRequestId) {
      return;
    }
    if (!annotations) {
      this.clearDecoration(editor);
      return;
    }

    const annotation = annotations.get(selectedLine);
    if (!annotation) {
      this.clearDecoration(editor);
      return;
    }

    let details: ChangelistDetails | undefined;
    if (annotation.sourceType === 'depot') {
      const config = this.p4ConfigByFile.get(filePath);
      if (!config) {
        this.clearDecoration(editor);
        return;
      }

      details = this.changeDetails.get(annotation.changeNum);
      if (!details) {
        console.log(`[P4Lens] Changelist cache miss: ${annotation.changeNum}`);
        details = await this.getOrFetchDescribe(annotation.changeNum, config, filePath) || undefined;
        if (requestId !== this.renderRequestId) {
          return;
        }
        if (details) {
          this.changeDetails.set(annotation.changeNum, details);
        }
      } else {
        console.log(`[P4Lens] Changelist cache hit: ${annotation.changeNum}`);
      }
    }

    const rendered = this.renderDisplayText(annotation, details);
    if (!this.showDecoration) {
      this.clearDecoration(editor);
      return;
    }

    const line = editor.document.lineAt(selectedLine - 1);
    const range = new vscode.Range(
      selectedLine - 1,
      line.range.end.character,
      selectedLine - 1,
      line.range.end.character
    );

    editor.setDecorations(this.decorationType, [{
      range,
      renderOptions: {
        after: {
          contentText: rendered,
        },
      },
    }]);
  }

  setShowDecoration(show: boolean, editor?: vscode.TextEditor): void {
    if (this.showDecoration === show) {
      return;
    }

    this.showDecoration = show;
    if (!show) {
      if (editor) {
        this.clearDecoration(editor);
      }

      for (const visibleEditor of vscode.window.visibleTextEditors) {
        this.clearDecoration(visibleEditor);
      }
    }
  }

  clearDecoration(editor?: vscode.TextEditor): void {
    const targetEditor = editor || vscode.window.activeTextEditor;
    if (!targetEditor) {
      return;
    }

    targetEditor.setDecorations(this.decorationType, []);
  }

  /**
   * Fetch annotations for a file
   */
  private async fetchAnnotations(
    document: vscode.TextDocument
  ): Promise<Map<number, LineAnnotation> | undefined> {
    try {
      const filePath = document.uri.fsPath;
      const config = await findP4Config(filePath);
      if (!config) {
        console.log(`[P4Lens] No P4 config found for ${filePath}`);
        return undefined;
      }

      this.p4ConfigByFile.set(filePath, config);

      const baseAnnotations = await runP4Annotate(filePath, config);
      if (!baseAnnotations) {
        return undefined;
      }

      const diffHunks = await runP4Diff(filePath, config);
      return mergeAnnotationsForCurrentDocument(baseAnnotations, diffHunks, document.lineCount);
    } catch (err) {
      console.error(`[P4Lens] Error fetching annotations: ${err}`);
      return undefined;
    }
  }

  /**
   * Clear cache for a specific file or all files
   */
  clearCache(filePath?: string): void {
    this.clearFileCaches(filePath);
    this.refreshCodeLenses();
  }

  clearCacheSilently(filePath?: string): void {
    this.clearFileCaches(filePath);
  }

  private clearFileCaches(filePath?: string): void {
    if (filePath) {
      this.annotations.delete(filePath);
      this.p4ConfigByFile.delete(filePath);
      this.fileOpenStateByPath.delete(filePath);
      this.symbolCodeLensFeature.clearCache(filePath);
    } else {
      this.annotations.clear();
      this.p4ConfigByFile.clear();
      this.changeDetails.clear();
      this.inFlightDescribe.clear();
      this.fileOpenStateByPath.clear();
      this.symbolCodeLensFeature.clearCache();
    }
  }

  getCachedFilePaths(): string[] {
    return Array.from(this.annotations.keys());
  }

  async clearChangedOpenStateCaches(): Promise<string[]> {
    const changedFilePaths: string[] = [];
    const cachedFilePaths = this.getCachedFilePaths();

    for (const filePath of cachedFilePaths) {
      const config = this.p4ConfigByFile.get(filePath);
      if (!config) {
        continue;
      }

      const isOpen = await runP4Opened(filePath, config);
      if (isOpen === null) {
        continue;
      }

      const previousIsOpen = this.fileOpenStateByPath.get(filePath);
      if (previousIsOpen === undefined) {
        this.fileOpenStateByPath.set(filePath, isOpen);
        continue;
      }

      if (previousIsOpen === isOpen) {
        continue;
      }

      console.log(`[P4Lens] Open state changed for ${filePath}: ${previousIsOpen} -> ${isOpen}`);
      changedFilePaths.push(filePath);
      this.clearCacheSilently(filePath);
    }

    if (changedFilePaths.length > 0) {
      this.refreshCodeLenses();
    }

    return changedFilePaths;
  }

  private async getOrFetchDescribe(
    changeNum: string,
    config: NonNullable<Awaited<ReturnType<typeof findP4Config>>>,
    filePath: string
  ): Promise<ChangelistDetails | null> {
    const existingRequest = this.inFlightDescribe.get(changeNum);
    if (existingRequest) {
      return existingRequest;
    }

    const request = runP4Describe(changeNum, config, filePath)
      .finally(() => {
        this.inFlightDescribe.delete(changeNum);
      });
    this.inFlightDescribe.set(changeNum, request);
    return request;
  }

  async provideHover(document: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover | undefined> {
    const symbolHover = await this.symbolCodeLensFeature.provideHover(document, position);
    if (symbolHover) {
      return symbolHover;
    }

    const filePath = document.uri.fsPath;
    const lineNumber = position.line + 1; // annotations are 1-based

    // Only show hover if hovering at the very end of the line (where decoration is rendered)
    const line = document.lineAt(position.line);
    if (position.character < line.range.end.character - 2) {
      return undefined;
    }

    const fileAnnotations = this.annotations.get(filePath);
    if (!fileAnnotations) {
      return undefined;
    }

    const annotation = fileAnnotations.get(lineNumber);
    if (!annotation || annotation.sourceType === 'local') {
      return undefined;
    }

    let details = this.changeDetails.get(annotation.changeNum);
    if (!details) {
      const config = this.p4ConfigByFile.get(filePath);
      if (!config) {
        return undefined;
      }
      const fetched = await this.getOrFetchDescribe(annotation.changeNum, config, filePath);
      if (!fetched) {
        return undefined;
      }
      details = fetched;
      this.changeDetails.set(annotation.changeNum, details);
    }

    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportThemeIcons = true;

    const escapedBy = this.escapeMarkdown(details.submittedBy);
    const escapedDesc = this.escapeMarkdown(details.description.trim());
    const descLines = escapedDesc.split('\n').filter(l => l.trim());
    const descFormatted = descLines.join('\n\n');
    const copyArg = encodeURIComponent(JSON.stringify(annotation.changeNum));

    md.appendMarkdown(`**${escapedBy}**, ${details.dateSubmitted}\n\n`);
    md.appendMarkdown(`${descFormatted}\n\n`);
    md.appendMarkdown(`---\n\n#\`${annotation.changeNum}\`\u00a0\u00a0[$(copy)](command:p4lenslite.copyChangelistNumber?${copyArg})`);

    const decorationText = this.renderDisplayText(annotation, details);
    const decorationWidth = this.calculateDecorationWidth(decorationText);
    const hoverRange = new vscode.Range(
      position.line,
      line.range.end.character,
      position.line,
      line.range.end.character + decorationWidth
    );
    return new vscode.Hover(md, hoverRange);
  }

  private escapeMarkdown(text: string): string {
    return text.replace(/[\\`*_{}[\]()#+!]/g, '\\$&');
  }

  refreshCodeLenses(): void {
    console.log('[P4Lens] CodeLens refresh requested');
    this.codeLensChangeEmitter.fire();
  }

  hasPendingSymbolProviderRefresh(): boolean {
    return this.symbolCodeLensFeature.hasPendingRefresh();
  }

  private async getOrFetchAnnotations(
    document: vscode.TextDocument
  ): Promise<Map<number, LineAnnotation> | undefined> {
    const filePath = document.uri.fsPath;
    const cachedAnnotations = this.annotations.get(filePath);
    if (cachedAnnotations) {
      return cachedAnnotations;
    }

    const fetchedAnnotations = await this.fetchAnnotations(document);
    if (!fetchedAnnotations) {
      return undefined;
    }

    this.annotations.set(filePath, fetchedAnnotations);
    return fetchedAnnotations;
  }

  private calculateDecorationWidth(decorationText: string): number {
    const leftMarginPx = 48;
    const averageCharWidthPx = 7;
    const marginChars = Math.ceil(leftMarginPx / averageCharWidthPx);
    return Math.max(1, decorationText.length + marginChars);
  }

  private renderDisplayText(annotation: LineAnnotation, details?: ChangelistDetails): string {
    if (annotation.sourceType === 'local') {
      return 'uncommitted changes';
    }

    const changeNum = details?.changeNum || annotation.changeNum;
    const submittedBy = details?.submittedBy || annotation.user;
    const dateSubmitted = details?.dateSubmitted || 'N/A';
    const description = details?.description || 'N/A';
    const oneLineDescription = description.replace(/\s+/g, ' ').trim();

    return `${submittedBy}, #${changeNum}, ${dateSubmitted}, ${oneLineDescription}`;
  }

  dispose(): void {
    this.codeLensChangeEmitter.dispose();
    this.decorationType.dispose();
  }
}
