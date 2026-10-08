/**
 * What a request stored in the bucket, for the S3 run of the suite
 * (`PARITY_S3=1`): both APIs then keep uploads in one S3 server, as a
 * deployment with `USE_S3=1` does, and a row's file name says only where the
 * object should be. This reads the object itself -- its bytes, and the type
 * and encoding stored with it, which django-storages sets from the upload.
 *
 * The client is the Nest API's own (`dist/common/s3.js`): the harness has no
 * other, and the server checks every signature it makes. It reads what
 * Django's boto3 stored as readily as what the Nest API did.
 */
import { createHash } from 'node:crypto';

import type pg from 'pg';

export const BUCKET_MODE = process.env.PARITY_S3 === '1';

interface Client {
  head(
    key: string,
  ): Promise<{ contentType: string | null; contentEncoding: string | null; size: number } | null>;
  get(key: string): Promise<Buffer | null>;
}

const DIST = '../dist';

let client: Promise<{ client: Client; key: (name: string) => string }> | null = null;

function s3(): Promise<{ client: Client; key: (name: string) => string }> {
  client ??= (async () => {
    // Through a variable, as serve.ts loads the build: there is no `dist` when
    // the harness is type-checked.
    const module = (await import(`${DIST}/common/s3.js`)) as {
      S3Client: new (settings: Record<string, unknown>) => Client;
      s3Key(name: string): string;
    };
    return {
      client: new module.S3Client({
        endpoint: process.env.S3_ENDPOINT || null,
        bucket: process.env.S3_BUCKET ?? '',
        accessKey: process.env.S3_ACCESS_KEY ?? '',
        secretKey: process.env.S3_SECRET_KEY ?? '',
        region: process.env.S3_REGION || 'us-east-1',
      }),
      key: module.s3Key,
    };
  })();
  return client;
}

/** Every column a request can store an upload through. */
const FILE_COLUMNS = `
  SELECT image AS name FROM catalog_productimage WHERE image <> ''
  UNION SELECT image FROM content_navigationitem WHERE image <> ''
  UNION SELECT image FROM content_storefrontbanner WHERE image <> ''
  UNION SELECT attachment FROM finance_expense WHERE attachment <> ''`;

/** The file names the rows hold now. */
export async function fileNames(db: pg.Client): Promise<Set<string>> {
  return new Set((await db.query<{ name: string }>(FILE_COLUMNS)).rows.map((row) => row.name));
}

/**
 * A name as both sides would have it. The second API to store `a.png` finds
 * the first one's object there and is given `a_Xy12AbC.png`, as on disk; a
 * receipt's name is thirty-two random hex digits on either side.
 */
function comparable(name: string): string {
  return name.replace(/[0-9a-f]{32}/, '<random>').replace(/_[A-Za-z0-9]{7}((?:\.[^./]+)*)$/, '$1');
}

/**
 * The objects behind the names that were not there before: each as its name,
 * its size, a digest of its bytes, and the type and encoding stored with it
 * -- or as missing, where a row names an object the bucket does not hold.
 */
export async function storedObjects(db: pg.Client, before: Set<string>): Promise<unknown[]> {
  const { client: bucket, key } = await s3();
  const out: unknown[] = [];
  for (const name of [...(await fileNames(db))].filter((name) => !before.has(name)).sort()) {
    const head = await bucket.head(key(name));
    const bytes = head ? await bucket.get(key(name)) : null;
    out.push({
      name: comparable(name),
      stored: head !== null,
      size: head?.size ?? null,
      sha256: bytes ? createHash('sha256').update(bytes).digest('hex') : null,
      content_type: head?.contentType ?? null,
      content_encoding: head?.contentEncoding ?? null,
    });
  }
  return out.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
