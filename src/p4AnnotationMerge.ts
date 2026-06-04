import type { LineAnnotation, P4DiffHunk } from './p4Command';
import { TEXT_UNCOMMITTED } from './constDefine';

export function mergeAnnotationsForCurrentDocument(
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
      copyDepotAnnotation(mergedAnnotations, baseAnnotations, baseLineNumber, currentLineNumber, currentLineCount);
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
          mergedAnnotations.set(currentLineNumber, createLocalAnnotation(currentLineNumber));
        }
        currentLineNumber++;
        continue;
      }

      copyDepotAnnotation(mergedAnnotations, baseAnnotations, baseLineNumber, currentLineNumber, currentLineCount);
      baseLineNumber++;
      currentLineNumber++;
    }
  }

  while (currentLineNumber <= currentLineCount && baseLineNumber <= baseAnnotations.size) {
    copyDepotAnnotation(mergedAnnotations, baseAnnotations, baseLineNumber, currentLineNumber, currentLineCount);
    baseLineNumber++;
    currentLineNumber++;
  }

  return mergedAnnotations;
}

function copyDepotAnnotation(
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

function createLocalAnnotation(lineNumber: number): LineAnnotation {
  return {
    lineNumber,
    changeNum: 'local',
    user: TEXT_UNCOMMITTED,
    sourceType: 'local',
  };
}
