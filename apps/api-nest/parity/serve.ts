/**
 * The Nest API as the parity stack runs it (docker-compose.nest.yml): the
 * image's own application, with the stand-in payment gateway registered before
 * it listens (gateway.ts). The image's command, `node dist/main.js`, has no
 * such gateway and never loads this directory.
 */
import { parityGateway } from './gateway.ts';

interface App {
  get(token: unknown): { register(provider: unknown): void };
  listen(port: number, host: string): Promise<unknown>;
}

const DIST = '../dist';

async function main(): Promise<void> {
  const { createApp } = (await import(`${DIST}/app.factory.js`)) as {
    createApp(): Promise<{ app: App; env: { PORT: number } }>;
  };
  const { PaymentProviders } = (await import(`${DIST}/payments/providers.js`)) as {
    PaymentProviders: unknown;
  };
  const { app, env } = await createApp();
  app.get(PaymentProviders).register(await parityGateway());
  await app.listen(env.PORT, '0.0.0.0');
}

void main();
