import {
  P4LENS_EXTENSION_ID,
  P4LENS_LOG_PREFIX,
  TEMPLATE_TRACE_VERSION_TITLE,
  TEXT_NA,
} from './constDefine';

export function formatString(template: string, ...values: Array<string | number | boolean>): string {
  return template.replace(/\{(\d+)\}/g, (match, indexText) => {
    const index = Number.parseInt(indexText, 10);
    if (!Number.isFinite(index) || index < 0 || index >= values.length) {
      return match;
    }

    return String(values[index]);
  });
}

export function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

export function normalizeToSingleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function trimToOptionalString(text: string | undefined | null): string | undefined {
  if (typeof text !== 'string') {
    return undefined;
  }

  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+!]/g, '\\$&');
}

export function formatMarkdownDescription(description: string): string {
  const trimmedDescription = description.trim();
  if (!trimmedDescription) {
    return escapeMarkdown(TEXT_NA);
  }

  const escapedLines = splitLines(trimmedDescription)
    .map((line) => escapeMarkdown(line))
    .filter((line, index, allLines) => line.length > 0 || (index > 0 && index < allLines.length - 1));

  return escapedLines.join('\n\n');
}

export function buildChangelistSummaryText(
  submittedBy: string,
  changeNum: string,
  dateSubmitted: string,
  description: string
): string {
  return formatString(
    '{0}, #{1}, {2}, {3}',
    submittedBy,
    changeNum,
    dateSubmitted,
    normalizeToSingleLine(description) || TEXT_NA
  );
}

export function buildTraceVersionTitle(depth: number): string {
  return formatString(TEMPLATE_TRACE_VERSION_TITLE, depth);
}

export function buildExtensionConfigPath(configKey: string): string {
  return formatString('{0}.{1}', P4LENS_EXTENSION_ID, configKey);
}

export function buildLogMessage(template: string, ...values: Array<string | number | boolean>): string {
  return formatString('{0} {1}', P4LENS_LOG_PREFIX, formatString(template, ...values));
}
