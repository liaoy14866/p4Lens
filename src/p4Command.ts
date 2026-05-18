import { execFileSync } from 'child_process';
import * as path from 'path';
import { P4Config } from './p4Config';

const P4_MAX_BUFFER = 10 * 1024 * 1024;

export interface LineAnnotation {
  lineNumber: number;
  changeNum: string;
  user: string;
  sourceType: 'depot' | 'local';
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
    
    console.log(`[P4Lens] Executing: p4 annotate -c -u "${filePath}"`);
    const output = execFileSync('p4', ['annotate', '-c', '-u', filePath], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
      env,
      maxBuffer: P4_MAX_BUFFER,
    });

    return parseP4AnnotateOutput(output);
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

function getCommandOutputFromError(err: unknown): string {
  if (!err || typeof err !== 'object') {
    return '';
  }

  const errorWithOutput = err as { stdout?: string | Buffer };
  if (typeof errorWithOutput.stdout === 'string') {
    return errorWithOutput.stdout;
  }
  if (Buffer.isBuffer(errorWithOutput.stdout)) {
    return errorWithOutput.stdout.toString('utf-8');
  }

  return '';
}

/**
 * Parse the output of p4 annotate command
 * Expected format:
 *      1   12345  username    function foo() {
 *      2   12346  username    return value;
 * @param output The raw output from p4 annotate
 * @returns A map of line numbers to annotation info
 */
function parseP4AnnotateOutput(output: string): Map<number, LineAnnotation> {
  const annotations = new Map<number, LineAnnotation>();
  const lines = output.split('\n');
  let unmatchedCount = 0;
  let sourceLineNumber = 1;

  for (const line of lines) {
    // Skip empty lines
    if (!line.trim()) {
      continue;
    }

    // Skip metadata header line from p4 annotate output
    // Example: //depot/path/file.cs#24 - edit change 123456 (utf8+m)
    if (line.startsWith('//')) {
      continue;
    }

    const patternWithDate = line.match(/^\s*(\d+):\s+(\S+)\s+\d{4}\/\d{2}\/\d{2}\s+/);
    const patternColonNoDate = line.match(/^\s*(\d+):\s+(\S+)\s+/);
    const patternSpace = line.match(/^\s*(\d+)\s+(\S+)\s+/);

    if (patternWithDate || patternColonNoDate || patternSpace) {
      const changeNum = patternWithDate
        ? patternWithDate[1]
        : (patternColonNoDate ? patternColonNoDate[1] : patternSpace![1]);
      const user = patternWithDate
        ? patternWithDate[2]
        : (patternColonNoDate ? patternColonNoDate[2] : patternSpace![2]);

      annotations.set(sourceLineNumber, {
        lineNumber: sourceLineNumber,
        changeNum,
        user,
        sourceType: 'depot',
      });
      sourceLineNumber++;
    } else {
      unmatchedCount++;
      if (unmatchedCount <= 3) {
        console.log(`[P4Lens] Unmatched annotate line sample: ${line}`);
      }
    }
  }

  console.log(`[P4Lens] Parsed ${annotations.size} line annotations`);
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
