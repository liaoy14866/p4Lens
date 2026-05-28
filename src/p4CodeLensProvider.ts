import * as vscode from 'vscode';
import { findP4Config } from './p4Config';
import { runP4Annotate, runP4Describe, runP4Diff, runP4Opened, ChangelistDetails, LineAnnotation } from './p4Command';
import { mergeAnnotationsForCurrentDocument } from './p4AnnotationMerge';
import {
  buildCodeLensTitle,
  buildCodeLensTooltip,
  buildSymbolCollaboratorSummary,
  buildSymbolCodeLensHoverMarkdown,
  CachedSymbolData,
  createSymbolCodeLensHoverRange,
  createSymbolRangeKey,
  isPossibleCodeLensHoverPosition,
  loadSupportedSymbols,
  SymbolCollaboratorSummary,
} from './p4SymbolCodeLens';

const ENABLE_SYMBOL_CODELENS_CONFIG_KEY = 'enableSymbolCodeLens';
const SYMBOL_CODELENS_NOOP_COMMAND = 'p4lenslite.noopSymbolCodeLens';

export class P4CodeLensProvider implements vscode.HoverProvider, vscode.CodeLensProvider {
  private annotations: Map<string, Map<number, LineAnnotation>> = new Map();
  private changeDetails: Map<string, ChangelistDetails> = new Map();
  private inFlightDescribe: Map<string, Promise<ChangelistDetails | null>> = new Map();
  private p4ConfigByFile: Map<string, Awaited<ReturnType<typeof findP4Config>>> = new Map();
  private fileOpenStateByPath: Map<string, boolean> = new Map();
  private cachedSymbolDataByFile: Map<string, CachedSymbolData> = new Map();
  private pendingSymbolProviderRefreshByFile: Map<string, number> = new Map();
  private renderRequestId = 0;
  private showDecoration = true;
  private readonly codeLensChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.codeLensChangeEmitter.event;
  private readonly decorationType = vscode.window.createTextEditorDecorationType({
    after: {
      contentText: '',
      margin: '0 0 0 48px',
      color: new vscode.ThemeColor('disabledForeground'),
      fontStyle: 'italic',
    },
    isWholeLine: false,
  });

  async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
    console.log(`[P4Lens] provideCodeLenses requested: ${document.uri.fsPath}, version=${document.version}`);

    if (document.uri.scheme !== 'file' || !this.isSymbolCodeLensEnabled()) {
      console.log(`[P4Lens] CodeLens skipped: scheme=${document.uri.scheme}, enabled=${this.isSymbolCodeLensEnabled()}`);
      return [];
    }

    const symbolData = await this.getOrBuildSymbolData(document);
    if (!symbolData) {
      console.log(`[P4Lens] CodeLens skipped: no symbol data for ${document.uri.fsPath}`);
      return [];
    }

    const codeLenses: vscode.CodeLens[] = [];
    for (const symbol of symbolData.symbols) {
      const summary = symbolData.collaboratorSummaryByRangeKey.get(createSymbolRangeKey(symbol));
      const title = buildCodeLensTitle(summary);
      if (!title) {
        continue;
      }

      const anchorPosition = new vscode.Position(symbol.anchorLine - 1, 0);
      codeLenses.push(new vscode.CodeLens(
        new vscode.Range(anchorPosition, anchorPosition),
        {
          title,
          command: SYMBOL_CODELENS_NOOP_COMMAND,
          tooltip: buildCodeLensTooltip(summary),
        }
      ));
    }

    console.log(`[P4Lens] CodeLens generated ${codeLenses.length} entries for ${document.uri.fsPath}`);
    return codeLenses;
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
      this.cachedSymbolDataByFile.delete(filePath);
      this.pendingSymbolProviderRefreshByFile.delete(filePath);
    } else {
      this.annotations.clear();
      this.p4ConfigByFile.clear();
      this.changeDetails.clear();
      this.inFlightDescribe.clear();
      this.fileOpenStateByPath.clear();
      this.cachedSymbolDataByFile.clear();
      this.pendingSymbolProviderRefreshByFile.clear();
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
    const symbolHover = await this.provideSymbolCodeLensHover(document, position);
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

  private async provideSymbolCodeLensHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.Hover | undefined> {
    if (document.uri.scheme !== 'file' || !this.isSymbolCodeLensEnabled()) {
      return undefined;
    }

    if (!isPossibleCodeLensHoverPosition(document, position)) {
      return undefined;
    }

    const symbolData = await this.getOrBuildSymbolData(document);
    if (!symbolData) {
      return undefined;
    }

    const hoveredLineNumber = position.line + 1;
    for (const symbol of symbolData.symbols) {
      if (symbol.anchorLine !== hoveredLineNumber) {
        continue;
      }

      const summary = symbolData.collaboratorSummaryByRangeKey.get(createSymbolRangeKey(symbol));
      if (!summary || summary.contributors.length === 0) {
        continue;
      }

      const title = buildCodeLensTitle(summary);
      if (!title) {
        continue;
      }

      return new vscode.Hover(
        buildSymbolCodeLensHoverMarkdown(symbol, summary, (text) => this.escapeMarkdown(text)),
        createSymbolCodeLensHoverRange(document, position.line)
      );
    }

    return undefined;
  }

  private escapeMarkdown(text: string): string {
    return text.replace(/[\\`*_{}[\]()#+!]/g, '\\$&');
  }

  refreshCodeLenses(): void {
    console.log('[P4Lens] CodeLens refresh requested');
    this.codeLensChangeEmitter.fire();
  }

  hasPendingSymbolProviderRefresh(): boolean {
    return this.pendingSymbolProviderRefreshByFile.size > 0;
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

  private async getOrBuildSymbolData(document: vscode.TextDocument): Promise<CachedSymbolData | undefined> {
    const filePath = document.uri.fsPath;
    const cachedData = this.cachedSymbolDataByFile.get(filePath);
    if (cachedData && cachedData.documentVersion === document.version) {
      console.log(`[P4Lens] CodeLens symbol cache hit: ${filePath}, version=${document.version}, symbols=${cachedData.symbols.length}, hasProviderResult=${cachedData.hasSymbolProviderResult}`);
      return cachedData;
    }

    const symbolLoadResult = await loadSupportedSymbols(document);
    if (!symbolLoadResult.hasProviderResult) {
      console.log(`[P4Lens] CodeLens symbol provider not ready for ${filePath}`);
      this.pendingSymbolProviderRefreshByFile.set(filePath, document.version);
      return undefined;
    }

    this.pendingSymbolProviderRefreshByFile.delete(filePath);

    if (symbolLoadResult.symbols.length === 0) {
      console.log(`[P4Lens] CodeLens symbol provider returned 0 supported symbols for ${filePath}`);
      const emptySymbolData: CachedSymbolData = {
        documentVersion: document.version,
        symbols: [],
        collaboratorSummaryByRangeKey: new Map(),
        hasSymbolProviderResult: true,
      };
      this.cachedSymbolDataByFile.set(filePath, emptySymbolData);
      return emptySymbolData;
    }

    const annotations = await this.getOrFetchAnnotations(document);
    if (!annotations) {
      console.log(`[P4Lens] CodeLens skipped: no annotations for ${filePath}`);
      return undefined;
    }

    const collaboratorSummaryByRangeKey = new Map<string, SymbolCollaboratorSummary>();
    for (const symbol of symbolLoadResult.symbols) {
      collaboratorSummaryByRangeKey.set(
        createSymbolRangeKey(symbol),
        buildSymbolCollaboratorSummary(symbol, annotations, document.lineCount)
      );
    }

    const symbolData: CachedSymbolData = {
      documentVersion: document.version,
      symbols: symbolLoadResult.symbols,
      collaboratorSummaryByRangeKey,
      hasSymbolProviderResult: true,
    };
    this.cachedSymbolDataByFile.set(filePath, symbolData);
    console.log(`[P4Lens] CodeLens symbol cache built: ${filePath}, symbols=${symbolData.symbols.length}`);
    return symbolData;
  }

  private isSymbolCodeLensEnabled(): boolean {
    return vscode.workspace
      .getConfiguration('p4LensLite')
      .get<boolean>(ENABLE_SYMBOL_CODELENS_CONFIG_KEY, true);
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
