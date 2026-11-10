import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { createRecognizeHandler } from './recognize.mjs';

const root = new URL('../dist/', import.meta.url);
try {
  await readFile(new URL('index.html', root));
} catch {
  console.error('Build the app first with npm run build.');
  process.exit(1);
}

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
};

const port = Number(process.env.PORT ?? '4173');
const host = process.env.HOST ?? '127.0.0.1';
const recognize = createRecognizeHandler();
createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  response.setHeader('Cache-Control', 'no-cache');
  if (new URL(request.url, 'http://localhost').pathname === '/api/recognize') {
    await recognize(request, response);
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const file = pathname === '/' ? 'index.html' : pathname.slice(1);
    const type = types[extname(file)];
    if (!type || !/^[\w./-]+$/.test(file) || file.split('/').some(part => !part || part.startsWith('.'))) {
      response.writeHead(404).end();
      return;
    }
    const body = await readFile(new URL(file, root));
    response.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length })
      .end(request.method === 'HEAD' ? undefined : body);
  } catch {
    response.writeHead(404).end();
  }
}).listen(port, host, () => {
  console.log('Poker Study is available at http://' + host + ':' + port);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('Photo recognition needs ANTHROPIC_API_KEY. Manual card entry works without it.');
  }
});
