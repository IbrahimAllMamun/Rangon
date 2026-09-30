import { createApp } from './app.factory';

async function bootstrap(): Promise<void> {
  const { app, env } = await createApp();
  await app.listen(env.PORT, '0.0.0.0');
}

void bootstrap();
