import { execFileSync } from 'child_process';
import * as path from 'path';
import { P4Config } from './p4Config';
import { loadIntegrationAwareAnnotations } from './p4FilelogAnnotations';

const P4_MAX_BUFFER = 10 * 1024 * 1024;

export interface LineAnnotation {
  lineNumber: number;
  changeNum: string;
  user: string;
  sourceType: 'depot' | 'local';
}

interface RawAnnotationLine {
  lineNumber: number;
  changeNum: string;
}

export interface P4DiffHunk {
  baseStart: number;
  baseCount: number;
  currentStart: number;
  currentCount: number;
  lines: string[];
}

export interface ChangelistDetails {
  changeNum: string;
  dateSubmitted: string;
  submittedBy: string;
  description: string;
}

/**
 * Execute p4 annotate command and parse the output
 * @param filePath The path to the file to annotate
 * @param config The P4 configuration
 * @returns A map of line numbers to annotation info, or null if command fails
 */
export async function runP4Annotate(
  filePath: string,
  config: P4Config
): Promise<Map<number, LineAnnotation> | null> {
  try {
    const { env, cwd } = buildP4ExecOptions(config, filePath);

    console.log(`[P4Lens] Executing: p4 annotate -q -c -i "${filePath}"`);
    const annotateOutput = execFileSync('p4', ['annotate', '-q', '-c', '-i', filePath], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
      env,
      maxBuffer: P4_MAX_BUFFER,
    });

    const rawAnnotations = parseP4AnnotateOutput(annotateOutput);
    if (rawAnnotations.length === 0) {
      console.log('[P4Lens] No annotate lines parsed');
      return new Map<number, LineAnnotation>();
    }

    return loadIntegrationAwareAnnotations(
      filePath,
      rawAnnotations,
      (fileSpec) => buildP4ExecOptions(config, fileSpec)
    );
  } catch (err) {
    console.error(`[P4Lens] Error executing p4 annotate: ${err}`);
    return null;
  }
}

export async function runP4Diff(
  filePath: string,
  config: P4Config
): Promise<P4DiffHunk[]> {
  const { env, cwd } = buildP4ExecOptions(config, filePath);
  const diffEnv: NodeJS.ProcessEnv = { ...env };
  delete diffEnv.P4DIFF;
  delete diffEnv.P4DIFFUNICODE;

  console.log(`[P4Lens] Executing: p4 diff -du "${filePath}"`);

  try {
    const output = execFileSync('p4', ['diff', '-du', filePath], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
      env: diffEnv,
      maxBuffer: P4_MAX_BUFFER,
    });

    return parseP4DiffOutput(output);
  } catch (err) {
    const output = getCommandOutputFromError(err);
    if (output.trim()) {
      console.log('[P4Lens] p4 diff returned non-zero status; parsing captured output');
      return parseP4DiffOutput(output);
    }

    console.error(`[P4Lens] Error executing p4 diff: ${err}`);
    return [];
  }
}

export async function runP4Describe(
  changeNum: string,
  config: P4Config,
  filePath: string
): Promise<ChangelistDetails | null> {
  try {
    const { env, cwd } = buildP4ExecOptions(config, filePath);

    console.log(`[P4Lens] Executing: p4 change -o ${changeNum}`);
    const output = execFileSync('p4', ['change', '-o', changeNum], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
      env,
      maxBuffer: P4_MAX_BUFFER,
    });

    return parseP4ChangeOutput(output, changeNum);
  } catch (err) {
    console.error(`[P4Lens] Error executing p4 change: ${err}`);
    return null;
  }
}

export async function runP4Opened(
  filePath: string,
  config: P4Config
): Promise<boolean | null> {
  try {
    const { env, cwd } = buildP4ExecOptions(config, filePath);

    console.log(`[P4Lens] Executing: p4 opened "${filePath}"`);
    const output = execFileSync('p4', ['opened', filePath], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
      env,
      maxBuffer: P4_MAX_BUFFER,
    });

    return output.trim().length > 0;
  } catch (err) {
    const stdout = getCommandOutputFromError(err, 'stdout');
    if (stdout.trim().length > 0) {
      return true;
    }

    const stderr = getCommandOutputFromError(err, 'stderr');
    if (/not opened on this client/i.test(stderr)) {
      return false;
    }

    console.error(`[P4Lens] Error executing p4 opened: ${err}`);
    return null;
  }
}

function buildP4ExecOptions(config: P4Config, filePath: string): { env: NodeJS.ProcessEnv; cwd: string } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    P4PORT: config.P4PORT || config.port || process.env.P4PORT,
    P4USER: config.P4USER || config.user || process.env.P4USER,
    P4CLIENT: config.P4CLIENT || config.client || process.env.P4CLIENT,
    P4IGNORE: config.P4IGNORE || process.env.P4IGNORE,
    P4CONFIG: process.env.P4CONFIG || 'p4config.txt',
  };

  const cwd = config.configPath ? path.dirname(config.configPath) : path.dirname(filePath);
  return { env, cwd };
}

function getCommandOutputFromError(err: unknown): string;
function getCommandOutputFromError(err: unknown, stream: 'stdout' | 'stderr'): string;
function getCommandOutputFromError(err: unknown, stream: 'stdout' | 'stderr' = 'stdout'): string {
  if (!err || typeof err !== 'object') {
    return '';
  }

  const errorWithOutput = err as { stdout?: string | Buffer; stderr?: string | Buffer };
  const output = errorWithOutput[stream];
  if (typeof output === 'string') {
    return output;
  }
  if (Buffer.isBuffer(output)) {
    return output.toString('utf-8');
  }

  return '';
}

function splitIntoLines(output: string): string[] {
  return output.split(/\r?\n/);
}

/**
 * Parse the output of p4 annotate command
 * @param output The raw output from p4 annotate
 * @returns Per-line changelist info
 */
function parseP4AnnotateOutput(output: string): RawAnnotationLine[] {
  const annotations: RawAnnotationLine[] = [];
  const lines = splitIntoLines(output);
  let unmatchedCount = 0;
  let sourceLineNumber = 1;

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }

    const matches = /^(\d+): (.*?)$/.exec(line);
    if (matches) {
      annotations.push({
        lineNumber: sourceLineNumber,
        changeNum: matches[1],
      });
      sourceLineNumber++;
    } else {
      unmatchedCount++;
      if (unmatchedCount <= 3) {
        console.log(`[P4Lens] Unmatched annotate line sample: ${line}`);
      }
    }
  }

  console.log(`[P4Lens] Parsed ${annotations.length} line annotations`);
  return annotations;
}

function parseP4DiffOutput(output: string): P4DiffHunk[] {
  const hunks: P4DiffHunk[] = [];
  const lines = output.split('\n');
  let currentHunk: P4DiffHunk | null = null;

  for (const line of lines) {
    const hunkMatch = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
    if (hunkMatch) {
      if (currentHunk) {
        hunks.push(currentHunk);
      }

      currentHunk = {
        baseStart: Number.parseInt(hunkMatch[1], 10),
        baseCount: parseDiffRangeCount(hunkMatch[2]),
        currentStart: Number.parseInt(hunkMatch[3], 10),
        currentCount: parseDiffRangeCount(hunkMatch[4]),
        lines: [],
      };
      continue;
    }

    if (!currentHunk) {
      continue;
    }

    if (line.startsWith(' ') || line.startsWith('+') || line.startsWith('-') || line.startsWith('\\')) {
      currentHunk.lines.push(line);
    }
  }

  if (currentHunk) {
    hunks.push(currentHunk);
  }

  console.log(`[P4Lens] Parsed ${hunks.length} diff hunks`);
  return hunks;
}

function parseDiffRangeCount(rawCount: string | undefined): number {
  if (!rawCount) {
    return 1;
  }

  return Number.parseInt(rawCount, 10);
}

function parseP4ChangeOutput(output: string, fallbackChangeNum: string): ChangelistDetails {
  const lines = output.split('\n');
  let changeNum = fallbackChangeNum;
  let submittedBy = '';
  let dateSubmitted = '';
  const descriptionLines: string[] = [];
  let inDescription = false;

  for (const line of lines) {
    const changeMatch = line.match(/^\s*Change\s*:\s*(\d+)\s*$/i);
    if (changeMatch) {
      changeNum = changeMatch[1];
      continue;
    }

    const dateMatch = line.match(/^\s*Date\s*:\s*(.+?)\s*$/i);
    if (dateMatch) {
      dateSubmitted = dateMatch[1].trim();
      continue;
    }

    const userMatch = line.match(/^\s*User\s*:\s*(.+?)\s*$/i);
    if (userMatch) {
      submittedBy = userMatch[1].trim();
      continue;
    }

    if (/^\s*Description\s*:\s*$/i.test(line)) {
      inDescription = true;
      continue;
    }

    if (inDescription) {
      if (/^\s*[A-Z][A-Za-z]+\s*:\s*/.test(line)) {
        break;
      }

      const trimmed = line.replace(/^\t/, '').trim();
      if (trimmed.length > 0) {
        descriptionLines.push(trimmed);
      }
    }
  }

  const description = descriptionLines.join(' ').trim();
  return {
    changeNum,
    dateSubmitted,
    submittedBy,
    description,
  };
}
