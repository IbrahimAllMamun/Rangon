import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';

import { AppModule } from './app.module';
import { loadEnv } from './config/env';
import { genRequestId, installPipeline } from './http/pipeline';
import { RouteRegistry } from './http/routes';

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const routes = new RouteRegistry();

  const adapter = new FastifyAdapter({
    genReqId: genRequestId,
    // DATA_UPLOAD_MAX_MEMORY_SIZE in config/settings/base.py.
    bodyLimit: 10 * 1024 * 1024,
    routerOptions: { ignoreTrailingSlash: true, maxParamLength: 500 },
    trustProxy: env.DJANGO_TRUSTED_PROXY_HOPS > 0 ? env.DJANGO_TRUSTED_PROXY_HOPS : false,
    logger: false,
  });
  const fastify = adapter.getInstance();
  routes.attach(fastify);
  installPipeline(fastify, env);

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.forRoot(env, routes),
    adapter,
    {
      logger: ['log', 'warn', 'error'],
    },
  );
  app.enableShutdownHooks();
  await app.listen(env.PORT, '0.0.0.0');
}

void bootstrap();
