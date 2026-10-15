import { createApp } from './app.factory';

async function bootstrap(): Promise<void> {
  const { app, env } = await createApp();
  await app.listen(env.PORT, env.RANGON_LISTEN_ADDRESS);
}

void bootstrap();
