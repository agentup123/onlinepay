import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { env } from './config/env';
import { RedactingLogger } from './common/logger';
import { AppModule } from './app.module';
import { originCheck } from './common/origin.middleware';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true, // needed to verify webhook signatures
    logger: new RedactingLogger('API'),
  });

  // Correct client IPs behind the web app proxy / load balancer (see TRUST_PROXY_HOPS).
  app.set('trust proxy', env.TRUST_PROXY_HOPS);
  app.use(helmet());
  app.use(cookieParser());
  app.use(originCheck());
  app.useBodyParser('json', { limit: '256kb' });
  app.enableCors({ origin: [env.WEB_URL, env.ADMIN_URL], credentials: true });
  app.enableShutdownHooks();

  if (env.NODE_ENV !== 'production') {
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('OnlinePay API')
        .setVersion('0.1.0')
        .addCookieAuth('op_session')
        .build(),
    );
    SwaggerModule.setup('docs', app, doc);
  }

  await app.listen(env.API_PORT);
  new RedactingLogger('API').log(
    `API on ${env.API_URL} (NymCard: ${env.NYMCARD_MODE}, gateway: ${env.PAYMENT_GATEWAY}, KYC: ${env.KYC_PROVIDER})`,
  );
}

void bootstrap();
