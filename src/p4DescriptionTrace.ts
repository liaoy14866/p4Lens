import * as vscode from 'vscode';
import {
  DEFAULT_DESCRIPTION_TRACE_CHANGE_KEY,
  DEFAULT_DESCRIPTION_TRACE_DESCRIPTION_KEY,
  DEFAULT_DESCRIPTION_TRACE_MARKER,
  DEFAULT_DESCRIPTION_TRACE_PARSER,
  DEFAULT_DESCRIPTION_TRACE_STREAM_KEY,
  DEFAULT_DESCRIPTION_TRACE_USER_KEY,
  DESCRIPTION_TRACE_CHANGE_KEY_CONFIG_KEY,
  DESCRIPTION_TRACE_CONFIGURATION_PREFIX,
  DESCRIPTION_TRACE_DESCRIPTION_KEY_CONFIG_KEY,
  DESCRIPTION_TRACE_ENABLED_CONFIG_KEY,
  DESCRIPTION_TRACE_MARKER_CONFIG_KEY,
  DESCRIPTION_TRACE_MAX_DEPTH_CONFIG_KEY,
  DESCRIPTION_TRACE_PARSER_CONFIG_KEY,
  DESCRIPTION_TRACE_STREAM_KEY_CONFIG_KEY,
  DESCRIPTION_TRACE_USER_KEY_CONFIG_KEY,
} from './constDefine';
import { buildLogMessage, trimToOptionalString } from './stringUtils';

const DEFAULT_DESCRIPTION_TRACE_MAX_DEPTH = 8;

export type DescriptionTraceParser = 'json';

export interface DescriptionTraceSourceSnapshot {
  changelist?: string;
  user?: string;
  description?: string;
  stream?: string;
}

export interface DescriptionTraceConfig {
  enabled: boolean;
  marker: string;
  parser: DescriptionTraceParser;
  changeKey: string;
  userKey: string;
  descriptionKey: string;
  streamKey: string;
  maxDepth: number;
}

export interface ParsedDescriptionTraceSource {
  marker: string;
  parser: DescriptionTraceParser;
  rawPayload: string;
  sourceSnapshot: DescriptionTraceSourceSnapshot;
}

export function getDescriptionTraceConfig(): DescriptionTraceConfig {
  const configuration = vscode.workspace.getConfiguration('p4LensLite');
  const marker = configuration.get<string>(DESCRIPTION_TRACE_MARKER_CONFIG_KEY, DEFAULT_DESCRIPTION_TRACE_MARKER).trim();
  const parser = configuration.get<DescriptionTraceParser>(DESCRIPTION_TRACE_PARSER_CONFIG_KEY, DEFAULT_DESCRIPTION_TRACE_PARSER);
  const changeKey = configuration.get<string>(DESCRIPTION_TRACE_CHANGE_KEY_CONFIG_KEY, DEFAULT_DESCRIPTION_TRACE_CHANGE_KEY).trim();
  const userKey = configuration.get<string>(DESCRIPTION_TRACE_USER_KEY_CONFIG_KEY, DEFAULT_DESCRIPTION_TRACE_USER_KEY).trim();
  const descriptionKey = configuration.get<string>(DESCRIPTION_TRACE_DESCRIPTION_KEY_CONFIG_KEY, DEFAULT_DESCRIPTION_TRACE_DESCRIPTION_KEY).trim();
  const streamKey = configuration.get<string>(DESCRIPTION_TRACE_STREAM_KEY_CONFIG_KEY, DEFAULT_DESCRIPTION_TRACE_STREAM_KEY).trim();
  const configuredMaxDepth = configuration.get<number>(DESCRIPTION_TRACE_MAX_DEPTH_CONFIG_KEY, DEFAULT_DESCRIPTION_TRACE_MAX_DEPTH);
  const maxDepth = Number.isFinite(configuredMaxDepth) && configuredMaxDepth >= 1
    ? Math.floor(configuredMaxDepth)
    : DEFAULT_DESCRIPTION_TRACE_MAX_DEPTH;

  return {
    enabled: configuration.get<boolean>(DESCRIPTION_TRACE_ENABLED_CONFIG_KEY, true),
    marker,
    parser: parser === 'json' ? parser : DEFAULT_DESCRIPTION_TRACE_PARSER,
    changeKey,
    userKey,
    descriptionKey,
    streamKey,
    maxDepth,
  };
}

export function parseDescriptionTraceSource(
  description: string,
  config: DescriptionTraceConfig
): ParsedDescriptionTraceSource | null {
  if (!config.enabled || !config.marker || !config.changeKey) {
    return null;
  }

  const markerIndex = description.lastIndexOf(config.marker);
  if (markerIndex < 0) {
    return null;
  }

  const rawPayload = description.slice(markerIndex + config.marker.length).trim();
  if (!rawPayload) {
    return null;
  }

  if (config.parser !== 'json') {
    return null;
  }

  const parsedPayload = tryParseJsonObject(rawPayload);
  if (!parsedPayload) {
    console.log(buildLogMessage('Failed to parse description trace payload as JSON: {0}', rawPayload));
    return null;
  }

  const sourceSnapshot: DescriptionTraceSourceSnapshot = {
    changelist: getStringValue(parsedPayload, config.changeKey),
    user: getStringValue(parsedPayload, config.userKey),
    description: getStringValue(parsedPayload, config.descriptionKey),
    stream: getStringValue(parsedPayload, config.streamKey),
  };

  if (!sourceSnapshot.changelist) {
    return null;
  }

  return {
    marker: config.marker,
    parser: config.parser,
    rawPayload,
    sourceSnapshot,
  };
}

function tryParseJsonObject(rawPayload: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(rawPayload) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }

    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function getStringValue(payload: Record<string, unknown>, key: string): string | undefined {
  if (!key) {
    return undefined;
  }

  const value = payload[key];
  if (typeof value === 'string') {
    return trimToOptionalString(value);
  }

  if (typeof value === 'number') {
    return String(value);
  }

  return undefined;
}
