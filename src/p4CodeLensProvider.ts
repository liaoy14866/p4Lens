import * as vscode from 'vscode';
import { findP4Config } from './p4Config';
import { runP4Annotate, runP4Describe, runP4Diff, runP4Opened, ChangelistDetails, ChangelistTraceByDescInfo, LineAnnotation } from './p4Command';
import { mergeAnnotationsForCurrentDocument } from './p4AnnotationMerge';
import { getDescriptionTraceConfig, parseDescriptionTraceSource, DescriptionTraceSourceSnapshot } from './p4DescriptionTrace';
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
      getDisplayAnnotations: (document, annotations) => this.getDisplayAnnotations(document, annotations),
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

      details = await this.getOrFetchDescribe(annotation.changeNum, config, filePath) || undefined;
      if (requestId !== this.renderRequestId) {
        return;
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

  clearDescribeCache(): void {
    this.changeDetails.clear();
    this.inFlightDescribe.clear();
    this.symbolCodeLensFeature.clearCache();
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
    filePath: string,
    visitedChangeNums: Set<string> = new Set(),
    depth = 0
  ): Promise<ChangelistDetails | null> {
    if (visitedChangeNums.has(changeNum)) {
      console.log(`[P4Lens] Description trace cycle detected at changelist ${changeNum}`);
      return null;
    }

    const cachedDetails = this.changeDetails.get(changeNum);
    if (cachedDetails) {
      console.log(`[P4Lens] Changelist cache hit: ${changeNum}`);
      return cachedDetails;
    }

    const existingRequest = this.inFlightDescribe.get(changeNum);
    if (existingRequest) {
      return existingRequest;
    }

    console.log(`[P4Lens] Changelist cache miss: ${changeNum}`);
    const request = runP4Describe(changeNum, config, filePath)
      .then(async (details) => {
        if (!details) {
          return null;
        }

        const tracedDetails = await this.buildDescribeWithTrace(details, config, filePath, visitedChangeNums, depth);
        this.changeDetails.set(changeNum, tracedDetails);
        return tracedDetails;
      })
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
    }

    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportThemeIcons = true;

    this.appendHoverSection(md, 'Current', details);
    this.appendTraceSections(md, details.traceByDescInfo, 1);

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

  private async buildDescribeWithTrace(
    baseDetails: ChangelistDetails,
    config: NonNullable<Awaited<ReturnType<typeof findP4Config>>>,
    filePath: string,
    visitedChangeNums: Set<string>,
    depth: number
  ): Promise<ChangelistDetails> {
    const details: ChangelistDetails = {
      ...baseDetails,
      traceByDescInfo: null,
    };

    const traceConfig = getDescriptionTraceConfig();
    if (!traceConfig.enabled || depth >= traceConfig.maxDepth) {
      return details;
    }

    const parsedTraceSource = parseDescriptionTraceSource(details.description, traceConfig);
    if (!parsedTraceSource) {
      return details;
    }

    const nextVisitedChangeNums = new Set(visitedChangeNums);
    nextVisitedChangeNums.add(details.changeNum);
    const tracedChange = await this.getOrFetchDescribe(
      parsedTraceSource.sourceSnapshot.changelist!,
      config,
      filePath,
      nextVisitedChangeNums,
      depth + 1
    );

    details.traceByDescInfo = {
      marker: parsedTraceSource.marker,
      parser: parsedTraceSource.parser,
      rawPayload: parsedTraceSource.rawPayload,
      sourceSnapshot: parsedTraceSource.sourceSnapshot,
      tracedChange,
    };
    return details;
  }

  private appendHoverSection(
    md: vscode.MarkdownString,
    sectionTitle: string,
    details: ChangelistDetails,
    sourceSnapshot?: DescriptionTraceSourceSnapshot,
    isResolved = true
  ): void {
    if (md.value.length > 0) {
      md.appendMarkdown('\n\n---\n\n');
    }

    md.appendMarkdown(`**${this.escapeMarkdown(sectionTitle)}**\n\n`);

    if (isResolved) {
      md.appendMarkdown(`**${this.escapeMarkdown(details.submittedBy)}**, ${this.escapeMarkdown(details.dateSubmitted)}\n\n`);
      md.appendMarkdown(`${this.formatDescription(details.description)}\n\n`);
      md.appendMarkdown(this.buildChangelistCopyMarkdown(details.changeNum));
    }

    if (!sourceSnapshot) {
      return;
    }

    const metadataLines: string[] = [];
    if (sourceSnapshot.stream) {
      metadataLines.push(`Stream: ${this.escapeMarkdown(sourceSnapshot.stream)}`);
    }

    if (!isResolved) {
      metadataLines.push(`Source CL: #${this.escapeMarkdown(sourceSnapshot.changelist || 'N/A')}`);
      if (sourceSnapshot.user) {
        metadataLines.push(`Source User: ${this.escapeMarkdown(sourceSnapshot.user)}`);
      }
      if (sourceSnapshot.description) {
        metadataLines.push(`Source Description: ${this.escapeMarkdown(sourceSnapshot.description.replace(/\s+/g, ' ').trim())}`);
      }
      metadataLines.push('Unable to resolve the traced changelist.');
    }

    if (metadataLines.length > 0) {
      md.appendMarkdown(`\n\n${metadataLines.join('  \n')}`);
    }
  }

  private appendTraceSections(
    md: vscode.MarkdownString,
    traceInfo: ChangelistTraceByDescInfo | null,
    depth: number
  ): void {
    if (!traceInfo) {
      return;
    }

    if (traceInfo.tracedChange) {
      this.appendHoverSection(md, `Trace ${depth}`, traceInfo.tracedChange, traceInfo.sourceSnapshot);
      this.appendTraceSections(md, traceInfo.tracedChange.traceByDescInfo, depth + 1);
      return;
    }

    const unresolvedDetails: ChangelistDetails = {
      changeNum: traceInfo.sourceSnapshot.changelist || 'N/A',
      submittedBy: traceInfo.sourceSnapshot.user || 'unknown',
      dateSubmitted: 'N/A',
      description: traceInfo.sourceSnapshot.description || 'N/A',
      traceByDescInfo: null,
    };
    this.appendHoverSection(md, `Trace ${depth}`, unresolvedDetails, traceInfo.sourceSnapshot, false);
  }

  private buildChangelistCopyMarkdown(changeNum: string): string {
    const copyArg = encodeURIComponent(JSON.stringify(changeNum));
    return `#\`${this.escapeMarkdown(changeNum)}\`\u00a0\u00a0[$(copy)](command:p4lenslite.copyChangelistNumber?${copyArg})`;
  }

  private formatDescription(description: string): string {
    const trimmedDescription = description.trim();
    if (!trimmedDescription) {
      return this.escapeMarkdown('N/A');
    }

    const escapedLines = trimmedDescription
      .split(/\r?\n/)
      .map((line) => this.escapeMarkdown(line))
      .filter((line, index, allLines) => line.length > 0 || (index > 0 && index < allLines.length - 1));

    return escapedLines.join('\n\n');
  }

  private async getDisplayAnnotations(
    document: vscode.TextDocument,
    annotations: Map<number, LineAnnotation>
  ): Promise<Map<number, LineAnnotation>> {
    const filePath = document.uri.fsPath;
    const config = this.p4ConfigByFile.get(filePath);
    if (!config) {
      return annotations;
    }

    const depotAnnotations = Array.from(annotations.values()).filter((annotation) => annotation.sourceType === 'depot');
    const uniqueChangeNums = Array.from(new Set(depotAnnotations.map((annotation) => annotation.changeNum)));
    if (uniqueChangeNums.length === 0) {
      return annotations;
    }

    const earliestUserByChangeNum = new Map<string, string>();
    await Promise.all(uniqueChangeNums.map(async (changeNum) => {
      const details = await this.getOrFetchDescribe(changeNum, config, filePath);
      const fallbackUser = depotAnnotations.find((annotation) => annotation.changeNum === changeNum)?.user || 'unknown';
      earliestUserByChangeNum.set(changeNum, this.getEarliestTraceInfo(details)?.submittedBy || fallbackUser);
    }));

    const displayAnnotations = new Map<number, LineAnnotation>();
    for (const [lineNumber, annotation] of annotations.entries()) {
      if (annotation.sourceType !== 'depot') {
        displayAnnotations.set(lineNumber, annotation);
        continue;
      }

      displayAnnotations.set(lineNumber, {
        ...annotation,
        user: earliestUserByChangeNum.get(annotation.changeNum) || annotation.user,
      });
    }

    return displayAnnotations;
  }

  private getEarliestTraceInfo(details: ChangelistDetails | null | undefined): {
    changeNum: string;
    submittedBy: string;
    dateSubmitted: string;
    description: string;
  } | undefined {
    if (!details) {
      return undefined;
    }

    let earliestInfo = {
      changeNum: details.changeNum,
      submittedBy: details.submittedBy,
      dateSubmitted: details.dateSubmitted,
      description: details.description,
    };
    let currentTraceInfo = details.traceByDescInfo;

    while (currentTraceInfo) {
      if (!currentTraceInfo.tracedChange) {
        return {
          changeNum: currentTraceInfo.sourceSnapshot.changelist || earliestInfo.changeNum,
          submittedBy: currentTraceInfo.sourceSnapshot.user || earliestInfo.submittedBy,
          dateSubmitted: earliestInfo.dateSubmitted,
          description: currentTraceInfo.sourceSnapshot.description || earliestInfo.description,
        };
      }

      earliestInfo = {
        changeNum: currentTraceInfo.tracedChange.changeNum,
        submittedBy: currentTraceInfo.tracedChange.submittedBy,
        dateSubmitted: currentTraceInfo.tracedChange.dateSubmitted,
        description: currentTraceInfo.tracedChange.description,
      };
      currentTraceInfo = currentTraceInfo.tracedChange.traceByDescInfo;
    }

    return earliestInfo;
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

    const earliestInfo = this.getEarliestTraceInfo(details);
    const changeNum = earliestInfo?.changeNum || details?.changeNum || annotation.changeNum;
    const submittedBy = earliestInfo?.submittedBy || details?.submittedBy || annotation.user;
    const dateSubmitted = earliestInfo?.dateSubmitted || details?.dateSubmitted || 'N/A';
    const description = earliestInfo?.description || details?.description || 'N/A';
    const oneLineDescription = description.replace(/\s+/g, ' ').trim();

    return `${submittedBy}, #${changeNum}, ${dateSubmitted}, ${oneLineDescription}`;
  }

  dispose(): void {
    this.codeLensChangeEmitter.dispose();
    this.decorationType.dispose();
  }
}
