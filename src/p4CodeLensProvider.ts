import * as vscode from 'vscode';
import { findP4Config } from './p4Config';
import { runP4Annotate, runP4Describe, ChangelistDetails, LineAnnotation } from './p4Command';

export class P4CodeLensProvider {
  private annotations: Map<string, Map<number, LineAnnotation>> = new Map();
  private changeDetails: Map<string, ChangelistDetails> = new Map();
  private inFlightDescribe: Map<string, Promise<ChangelistDetails | null>> = new Map();
  private p4ConfigByFile: Map<string, Awaited<ReturnType<typeof findP4Config>>> = new Map();
  private renderRequestId = 0;
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
      annotations = await this.fetchAnnotations(filePath);
      if (requestId !== this.renderRequestId) {
        return;
      }
      if (annotations) {
        this.annotations.set(filePath, annotations);
      } else {
        editor.setDecorations(this.decorationType, []);
        return;
      }
    }

    const annotation = annotations.get(selectedLine);
    if (!annotation) {
      editor.setDecorations(this.decorationType, []);
      return;
    }

    const config = this.p4ConfigByFile.get(filePath);
    if (!config) {
      editor.setDecorations(this.decorationType, []);
      return;
    }

    let details = this.changeDetails.get(annotation.changeNum);
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

    const rendered = this.renderDisplayText(annotation, details);

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

  /**
   * Fetch annotations for a file
   */
  private async fetchAnnotations(
    filePath: string
  ): Promise<Map<number, LineAnnotation> | undefined> {
    try {
      const config = await findP4Config(filePath);
      if (!config) {
        console.log(`[P4Lens] No P4 config found for ${filePath}`);
        return undefined;
      }

      this.p4ConfigByFile.set(filePath, config);

      const annotations = await runP4Annotate(filePath, config);
      return annotations || undefined;
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
