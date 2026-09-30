import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';

import { AppModule } from './app.module';
import { loadEnv } from './config/env';
import { genRequestId, installPipeline } from './http/pipeline';
import { installBigIntJson, installBodyCapture } from './http/request-body';
import { RouteRegistry } from './http/routes';

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  installBigIntJson();
  const routes = new RouteRegistry();

  const adapter = new FastifyAdapter({
    genReqId: genRequestId,
    // DATA_UPLOAD_MAX_MEMORY_SIZE in config/settings/base.py.
    bodyLimit: 10 * 1024 * 1024,
    routerOptions: { ignoreTrailingSlash: true, maxParamLength: 500 },
    // Not Fastify's trustProxy: the client address is `core.ip`'s rule
    // (auth/throttle.ts), and the scheme is `SECURE_PROXY_SSL_HEADER`'s
    // (common/http.ts), each exactly as the Django API reads them.
    logger: false,
  });
  const fastify = adapter.getInstance();
  routes.attach(fastify);
  installPipeline(fastify, env);
  installBodyCapture(fastify);

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.forRoot(env, routes),
    adapter,
    {
      logger: ['log', 'warn', 'error'],
      // Bodies are parsed on first use, as DRF parses them (http/request-body.ts).
      bodyParser: false,
    },
  );
  app.enableShutdownHooks();
  await app.listen(env.PORT, '0.0.0.0');
}

void bootstrap();
