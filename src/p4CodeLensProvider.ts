import * as vscode from 'vscode';
import { findP4Config } from './p4Config';
import { runP4Annotate, runP4Describe, runP4Diff, ChangelistDetails, LineAnnotation, P4DiffHunk } from './p4Command';

export class P4CodeLensProvider {
  private annotations: Map<string, Map<number, LineAnnotation>> = new Map();
  private changeDetails: Map<string, ChangelistDetails> = new Map();
  private inFlightDescribe: Map<string, Promise<ChangelistDetails | null>> = new Map();
  private p4ConfigByFile: Map<string, Awaited<ReturnType<typeof findP4Config>>> = new Map();
  private renderRequestId = 0;
  private showDecoration = true;
  private readonly decorationType = vscode.window.createTextEditorDecorationType({
    after: {
      contentText: '',
      margin: '0 0 0 48px',
      color: new vscode.ThemeColor('disabledForeground'),
      fontStyle: 'italic',
    },
    isWholeLine: false,
  });

  /**
   * Update decoration for selected line only
   */
  async updateDecorationsForSelection(editor: vscode.TextEditor): Promise<void> {
    const requestId = ++this.renderRequestId;
    const filePath = editor.document.uri.fsPath;
    const selectedLine = editor.selection.active.line + 1;

    // Get or fetch annotations
    let annotations = this.annotations.get(filePath);
    if (!annotations) {
      annotations = await this.fetchAnnotations(editor.document);
      if (requestId !== this.renderRequestId) {
        return;
      }
      if (annotations) {
        this.annotations.set(filePath, annotations);
      } else {
        this.clearDecoration(editor);
        return;
      }
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
      return this.mergeAnnotationsForCurrentDocument(baseAnnotations, diffHunks, document.lineCount);
    } catch (err) {
      console.error(`[P4Lens] Error fetching annotations: ${err}`);
      return undefined;
    }
  }

  /**
   * Clear cache for a specific file or all files
   */
  clearCache(filePath?: string): void {
    if (filePath) {
      this.annotations.delete(filePath);
      this.p4ConfigByFile.delete(filePath);
    } else {
      this.annotations.clear();
      this.p4ConfigByFile.clear();
      this.changeDetails.clear();
      this.inFlightDescribe.clear();
    }
  }

  private mergeAnnotationsForCurrentDocument(
    baseAnnotations: Map<number, LineAnnotation>,
    diffHunks: P4DiffHunk[],
    currentLineCount: number
  ): Map<number, LineAnnotation> {
    const mergedAnnotations = new Map<number, LineAnnotation>();
    let baseLineNumber = 1;
    let currentLineNumber = 1;

    for (const hunk of diffHunks) {
      const unchangedLineCount = Math.min(
        Math.max(0, hunk.baseStart - baseLineNumber),
        Math.max(0, hunk.currentStart - currentLineNumber)
      );

      for (let index = 0; index < unchangedLineCount; index++) {
        this.copyDepotAnnotation(mergedAnnotations, baseAnnotations, baseLineNumber, currentLineNumber, currentLineCount);
        baseLineNumber++;
        currentLineNumber++;
      }

      for (const diffLine of hunk.lines) {
        if (diffLine.startsWith('\\')) {
          continue;
        }

        if (diffLine.startsWith('-')) {
          baseLineNumber++;
          continue;
        }

        if (diffLine.startsWith('+')) {
          if (currentLineNumber <= currentLineCount) {
            mergedAnnotations.set(currentLineNumber, this.createLocalAnnotation(currentLineNumber));
          }
          currentLineNumber++;
          continue;
        }

        this.copyDepotAnnotation(mergedAnnotations, baseAnnotations, baseLineNumber, currentLineNumber, currentLineCount);
        baseLineNumber++;
        currentLineNumber++;
      }
    }

    while (currentLineNumber <= currentLineCount && baseLineNumber <= baseAnnotations.size) {
      this.copyDepotAnnotation(mergedAnnotations, baseAnnotations, baseLineNumber, currentLineNumber, currentLineCount);
      baseLineNumber++;
      currentLineNumber++;
    }

    return mergedAnnotations;
  }

  private copyDepotAnnotation(
    mergedAnnotations: Map<number, LineAnnotation>,
    baseAnnotations: Map<number, LineAnnotation>,
    baseLineNumber: number,
    currentLineNumber: number,
    currentLineCount: number
  ): void {
    if (currentLineNumber > currentLineCount) {
      return;
    }

    const annotation = baseAnnotations.get(baseLineNumber);
    if (!annotation) {
      return;
    }

    mergedAnnotations.set(currentLineNumber, {
      ...annotation,
      lineNumber: currentLineNumber,
      sourceType: 'depot',
    });
  }

  private createLocalAnnotation(lineNumber: number): LineAnnotation {
    return {
      lineNumber,
      changeNum: 'local',
      user: 'uncommitted',
      sourceType: 'local',
    };
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

  private renderDisplayText(annotation: LineAnnotation, details?: ChangelistDetails): string {
    if (annotation.sourceType === 'local') {
      return '// local, uncommitted changes';
    }

    const changeNum = details?.changeNum || annotation.changeNum;
    const submittedBy = details?.submittedBy || annotation.user;
    const dateSubmitted = details?.dateSubmitted || 'N/A';
    const description = details?.description || 'N/A';
    const oneLineDescription = description.replace(/\s+/g, ' ').trim();

    return `// ${submittedBy}, #${changeNum}, ${dateSubmitted}, ${oneLineDescription}`;
  }

  dispose(): void {
    this.decorationType.dispose();
  }
}
