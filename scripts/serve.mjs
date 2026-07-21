import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { createGzip } from 'node:zlib';

const rootDir = resolve(import.meta.dirname, '..');
const port = Number.parseInt(process.env.PORT ?? '5173', 10);
const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.geojson': 'application/geo+json',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.pmtiles': 'application/octet-stream',
};
const compressibleExtensions = new Set(['.css', '.geojson', '.html', '.js', '.json']);

function requestedFilePath(requestUrl) {
  const pathname = decodeURIComponent(new URL(requestUrl, 'http://localhost').pathname);
  const normalizedPath = pathname === '/' ? '/index.html' : pathname;
  const filePath = resolve(rootDir, `.${normalizedPath}`);

  if (filePath !== rootDir && !filePath.startsWith(`${rootDir}${sep}`)) {
    return null;
  }

  return filePath;
}

function requestedRange(rangeHeader, size) {
  const match = rangeHeader?.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;

  const start = match[1] ? Number.parseInt(match[1], 10) : 0;
  const end = match[2] ? Number.parseInt(match[2], 10) : size - 1;

  if (start < 0 || end < start || start >= size) return false;
  return { start, end: Math.min(end, size - 1) };
}

const server = createServer(async (request, response) => {
  try {
    const filePath = requestedFilePath(request.url);
    if (!filePath) {
      response.writeHead(403).end('Forbidden');
      return;
    }

    const file = await stat(filePath);
    if (!file.isFile()) throw new Error('Not a file');

    const range = requestedRange(request.headers.range, file.size);
    if (range === false) {
      response.writeHead(416, { 'Content-Range': `bytes */${file.size}` }).end();
      return;
    }

    const headers = {
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
      'Content-Type': mimeTypes[extname(filePath)] ?? 'application/octet-stream',
    };

    const shouldCompress =
      !range &&
      compressibleExtensions.has(extname(filePath)) &&
      request.headers['accept-encoding']?.includes('gzip');

    if (range) {
      headers['Content-Length'] = range.end - range.start + 1;
      headers['Content-Range'] = `bytes ${range.start}-${range.end}/${file.size}`;
      response.writeHead(206, headers);
    } else if (shouldCompress) {
      headers['Content-Encoding'] = 'gzip';
      headers.Vary = 'Accept-Encoding';
      response.writeHead(200, headers);
    } else {
      headers['Content-Length'] = file.size;
      response.writeHead(200, headers);
    }

    if (request.method === 'HEAD') {
      response.end();
      return;
    }

    const input = createReadStream(filePath, range || undefined);
    if (shouldCompress) {
      input.pipe(createGzip()).pipe(response);
    } else {
      input.pipe(response);
    }
  } catch {
    response.writeHead(404).end('Not found');
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Transit Colors running at http://127.0.0.1:${port}`);
});
