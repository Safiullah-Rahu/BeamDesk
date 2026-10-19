/** Streams received files to disk: "<name>.part" while downloading, renamed when complete. */
import fs from 'node:fs';
import path from 'node:path';
import { sanitizeFileName } from '@beamdesk/core/files';

interface Handle {
  stream: fs.WriteStream;
  partPath: string;
  finalPath: string;
  size: number;
  written: number;
}

const MAX_OPEN = 8;
const handles = new Map<number, Handle>();
let nextHandle = 1;

/** Paths this app created; only these can be revealed in the file manager. */
export const createdFiles = new Set<string>();

function uniquePath(dir: string, name: string): string {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let candidate = path.join(dir, name);
  for (let i = 1; fs.existsSync(candidate) || fs.existsSync(`${candidate}.part`); i++) {
    candidate = path.join(dir, `${base} (${i})${ext}`);
  }
  return candidate;
}

export function openFile(dir: string, name: unknown, size: unknown): number | null {
  if (handles.size >= MAX_OPEN) return null;
  const safe = sanitizeFileName(String(name ?? 'file'));
  const total = Number(size);
  if (!Number.isFinite(total) || total < 0) return null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const finalPath = uniquePath(dir, safe);
    const partPath = `${finalPath}.part`;
    const stream = fs.createWriteStream(partPath, { flags: 'wx' });
    const id = nextHandle++;
    handles.set(id, { stream, partPath, finalPath, size: total, written: 0 });
    stream.on('error', () => abortFile(id));
    return id;
  } catch (err) {
    console.warn('[files] cannot create file', (err as Error).message);
    return null;
  }
}

export async function writeFile(id: number, chunk: Uint8Array): Promise<void> {
  const h = handles.get(id);
  if (!h) throw new Error('unknown file');
  if (!(chunk instanceof Uint8Array)) throw new Error('bad chunk');
  h.written += chunk.byteLength;
  if (h.written > h.size) throw new Error('file larger than announced');
  if (!h.stream.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))) {
    await new Promise<void>((resolve) => h.stream.once('drain', resolve));
  }
}

export async function closeFile(id: number): Promise<string> {
  const h = handles.get(id);
  if (!h) throw new Error('unknown file');
  handles.delete(id);
  await new Promise<void>((resolve, reject) => h.stream.end((err?: Error | null) => (err ? reject(err) : resolve())));
  await fs.promises.rename(h.partPath, h.finalPath);
  createdFiles.add(h.finalPath);
  return h.finalPath;
}

export function abortFile(id: number): void {
  const h = handles.get(id);
  if (!h) return;
  handles.delete(id);
  h.stream.destroy();
  fs.promises.unlink(h.partPath).catch(() => undefined);
}

export function abortAll(): void {
  for (const id of [...handles.keys()]) abortFile(id);
}
