/**
 * Where the parity stack's background jobs send things, so that what the
 * Django task and the Nest handler send can be compared: an SMTP server that
 * keeps every message, and the storefront's revalidation endpoint.
 *
 *   SMTP  :1025          every message, decoded to what a reader sees
 *   HTTP  :8025
 *     POST /api/revalidate   kept, and answered as the web app answers
 *     GET  /take             everything kept since the last take, then forgotten
 *     POST /mode             {"mail": "refuse" | "ok", "revalidate": "refuse" | "ok"}
 *
 * Two mail clients encode one message two ways (Python's `email` and
 * nodemailer differ in header folding, transfer encoding and line endings),
 * so a message is kept as its sender, its recipients, its subject and its
 * text -- decoded, with line endings as `\n` and none trailing.
 *
 * Only in the parity stack (docker-compose.nest.yml); no image runs it.
 */
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';

interface Mail {
  envelopeFrom: string;
  envelopeTo: string[];
  from: string;
  to: string;
  subject: string;
  text: string;
}

let mail: (Mail | { refused: string })[] = [];
let pings: unknown[] = [];
const mode = { mail: 'ok', revalidate: 'ok' };

/** RFC 2047: `=?utf-8?q?...?=` and `=?utf-8?b?...?=`, adjacent words joined. */
function decodeWords(value: string): string {
  return value
    .replace(/(\?=)\s+(=\?)/g, '$1$2')
    .replace(
      /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g,
      (_match, _charset: string, kind: string, text: string) => {
        const bytes =
          kind.toLowerCase() === 'b'
            ? Buffer.from(text, 'base64')
            : Buffer.from(
                text
                  .replaceAll('_', ' ')
                  .replace(/=([0-9A-Fa-f]{2})/g, (_hex, code: string) =>
                    String.fromCharCode(parseInt(code, 16)),
                  ),
                'latin1',
              );
        return bytes.toString('utf8');
      },
    );
}

function decodeBody(body: string, encoding: string): string {
  const kind = encoding.trim().toLowerCase();
  if (kind === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  if (kind === 'quoted-printable') {
    const joined = body.replace(/=\r?\n/g, '');
    return Buffer.from(
      joined.replace(/=([0-9A-Fa-f]{2})/g, (_hex, code: string) =>
        String.fromCharCode(parseInt(code, 16)),
      ),
      'latin1',
    ).toString('utf8');
  }
  // 7bit and 8bit: the bytes are the text.
  return Buffer.from(body, 'latin1').toString('utf8');
}

function parse(raw: string, envelopeFrom: string, envelopeTo: string[]): Mail {
  const split = raw.indexOf('\r\n\r\n');
  const head = split === -1 ? raw : raw.slice(0, split);
  const body = split === -1 ? '' : raw.slice(split + 4);
  const headers = new Map<string, string>();
  for (const line of head.replace(/\r\n[ \t]+/g, ' ').split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon > 0) headers.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim());
  }
  // The header's bytes, as UTF-8: a client may send it raw (SMTPUTF8) or as encoded words.
  const header = (name: string) =>
    decodeWords(Buffer.from(headers.get(name) ?? '', 'latin1').toString('utf8'));
  return {
    envelopeFrom,
    envelopeTo,
    from: header('from'),
    to: header('to'),
    subject: header('subject'),
    text: decodeBody(body, headers.get('content-transfer-encoding') ?? '7bit')
      .replace(/\r\n/g, '\n')
      .replace(/\n+$/, ''),
  };
}

const address = (argument: string) => /<([^>]*)>/.exec(argument)?.[1] ?? argument.trim();

createServer((socket) => {
  socket.setEncoding('latin1');
  let buffer = '';
  let reading = false;
  let from = '';
  let to: string[] = [];
  const say = (line: string) => socket.write(`${line}\r\n`);
  say('220 sink ESMTP');
  socket.on('error', () => undefined);
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    for (;;) {
      if (reading) {
        const end = buffer.indexOf('\r\n.\r\n');
        if (end === -1 && !buffer.startsWith('.\r\n')) return;
        const data = end === -1 ? '' : buffer.slice(0, end);
        buffer = buffer.slice(end === -1 ? 3 : end + 5);
        reading = false;
        // Dot-stuffing: a line that began with a dot was sent with two.
        mail.push(parse(data.replace(/\r\n\.\./g, '\r\n.').replace(/^\.\./, '.'), from, to));
        from = '';
        to = [];
        say('250 kept');
        continue;
      }
      const newline = buffer.indexOf('\r\n');
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 2);
      const verb = line.slice(0, 4).toUpperCase();
      if (verb === 'EHLO' || verb === 'HELO') {
        socket.write('250-sink\r\n250-8BITMIME\r\n250 SMTPUTF8\r\n');
      } else if (verb === 'MAIL') {
        from = address(line.slice(line.indexOf(':') + 1).split(' ')[0] ?? '');
        say('250 ok');
      } else if (verb === 'RCPT') {
        const recipient = address(line.slice(line.indexOf(':') + 1));
        if (mode.mail === 'refuse') {
          mail.push({ refused: recipient });
          say('550 no such user');
        } else {
          to.push(recipient);
          say('250 ok');
        }
      } else if (verb === 'DATA') {
        if (!to.length) say('503 no recipients');
        else {
          reading = true;
          say('354 go on');
        }
      } else if (verb === 'QUIT') {
        say('221 bye');
        socket.end();
        return;
      } else {
        // RSET, NOOP and anything else a client says in passing.
        say('250 ok');
      }
    }
  });
}).listen(1025, '0.0.0.0');

createHttpServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const answer = (status: number, payload: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(payload));
    };
    const path = (request.url ?? '').split('?')[0];
    if (request.method === 'POST' && path === '/api/revalidate') {
      let parsed: unknown = body;
      try {
        parsed = JSON.parse(body);
      } catch {
        // Kept as it came.
      }
      const refused = mode.revalidate === 'refuse';
      pings.push({
        body: parsed,
        contentType: request.headers['content-type'] ?? null,
        secret: request.headers['x-revalidate-secret'] ?? null,
        ...(refused ? { refused: true } : {}),
      });
      answer(refused ? 503 : 200, refused ? { error: 'refused' } : { revalidated: true });
    } else if (request.method === 'GET' && path === '/take') {
      answer(200, { mail, pings });
      mail = [];
      pings = [];
    } else if (request.method === 'POST' && path === '/mode') {
      const wanted = JSON.parse(body || '{}') as Partial<typeof mode>;
      mode.mail = wanted.mail ?? 'ok';
      mode.revalidate = wanted.revalidate ?? 'ok';
      answer(200, mode);
    } else {
      answer(path === '/health' ? 200 : 404, { ok: path === '/health' });
    }
  });
}).listen(8025, '0.0.0.0');

console.log('parity sink: SMTP on 1025, HTTP on 8025');
