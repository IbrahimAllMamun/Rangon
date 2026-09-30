/**
 * The same storefront requests to both APIs under load: throughput and
 * latency per endpoint. Memory is read from outside (`docker stats`), before
 * and after, by scripts/nest-parity.sh bench.
 *
 *   docker compose -p rangon-nest -f docker-compose.nest.yml run --rm parity node parity/bench.ts
 *
 * Run against the parity stack, where rate limits are off on both sides.
 * Sequential per API -- never both at once -- so neither steals the other's CPU.
 */
import { Agent, request } from 'node:http';

const APIS = {
  django: new URL(process.env.DJANGO_BASE ?? 'http://django:8000'),
  nest: new URL(process.env.NEST_BASE ?? 'http://nest:3000'),
};
const REQUESTS = Number(process.env.BENCH_REQUESTS ?? 400);
const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY ?? 8);

const ENDPOINTS = [
  '/api/health/',
  '/api/v1/shop/categories/',
  '/api/v1/shop/products/',
  '/api/v1/shop/products/?q=shirt',
  '/api/v1/shop/products/classic-oxford-shirt/',
  '/api/v1/shop/home/',
  '/api/v1/shop/navigation/',
];

function once(agent: Agent, base: URL, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    const req = request(
      { host: base.hostname, port: base.port, path, agent, headers: { host: 'localhost' } },
      (res) => {
        res.resume();
        res.on('end', () => {
          if ((res.statusCode ?? 0) >= 400) reject(new Error(`${path} answered ${res.statusCode}`));
          else resolve(Number(process.hrtime.bigint() - started) / 1e6);
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function load(
  base: URL,
  path: string,
  total: number,
): Promise<{ seconds: number; latencies: number[] }> {
  // Keep-alive, as a proxy in front of either API would use.
  const agent = new Agent({ keepAlive: true, maxSockets: CONCURRENCY });
  const latencies: number[] = [];
  let next = 0;
  const started = process.hrtime.bigint();
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < total) {
        next += 1;
        latencies.push(await once(agent, base, path));
      }
    }),
  );
  agent.destroy();
  return { seconds: Number(process.hrtime.bigint() - started) / 1e9, latencies };
}

const percentile = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;

async function main(): Promise<void> {
  console.log(`${REQUESTS} requests per endpoint per API, ${CONCURRENCY} at a time\n`);
  console.log('endpoint'.padEnd(46) + 'api     req/s    p50 ms   p95 ms   p99 ms');
  for (const path of ENDPOINTS) {
    for (const [name, base] of Object.entries(APIS)) {
      await load(base, path, 20); // warm-up
      const { seconds, latencies } = await load(base, path, REQUESTS);
      const sorted = [...latencies].sort((a, b) => a - b);
      console.log(
        `${path.padEnd(46)}${name.padEnd(8)}${(REQUESTS / seconds).toFixed(0).padStart(5)}` +
          `${percentile(sorted, 0.5).toFixed(1).padStart(9)}${percentile(sorted, 0.95).toFixed(1).padStart(9)}` +
          `${percentile(sorted, 0.99).toFixed(1).padStart(9)}`,
      );
    }
  }
}

void main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 2;
  })
  .finally(() => process.exit());
