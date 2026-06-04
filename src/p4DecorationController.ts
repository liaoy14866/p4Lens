import * as vscode from 'vscode';
import { ChangelistDetails, LineAnnotation } from './p4Command';
import { P4LensDataService } from './p4LensDataService';

export class P4DecorationController implements vscode.Disposable {
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

  constructor(private readonly dataService: P4LensDataService) {}

  async updateDecorationsForSelection(editor: vscode.TextEditor): Promise<void> {
    const requestId = ++this.renderRequestId;
    const selectedLine = editor.selection.active.line + 1;
    const annotations = await this.dataService.getAnnotations(editor.document);
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
      details = await this.dataService.getDetailsForChange(annotation.changeNum, editor.document.uri.fsPath) || undefined;
      if (!details) {
        this.clearDecoration(editor);
        return;
      }
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

  calculateDecorationWidth(decorationText: string): number {
    const leftMarginPx = 48;
    const averageCharWidthPx = 7;
    const marginChars = Math.ceil(leftMarginPx / averageCharWidthPx);
    return Math.max(1, decorationText.length + marginChars);
  }

  private renderDisplayText(annotation: LineAnnotation, details?: ChangelistDetails): string {
    if (annotation.sourceType === 'local') {
      return 'uncommitted changes';
    }

    const earliestInfo = this.dataService.getEarliestTraceInfo(details);
    const changeNum = earliestInfo?.changeNum || details?.changeNum || annotation.changeNum;
    const submittedBy = earliestInfo?.submittedBy || details?.submittedBy || annotation.user;
    const dateSubmitted = earliestInfo?.dateSubmitted || details?.dateSubmitted || 'N/A';
    const description = earliestInfo?.description || details?.description || 'N/A';
    const oneLineDescription = description.replace(/\s+/g, ' ').trim();

    return `${submittedBy}, #${changeNum}, ${dateSubmitted}, ${oneLineDescription}`;
  }

  dispose(): void {
    this.decorationType.dispose();
  }
}
