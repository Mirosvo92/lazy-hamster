import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
    const app = await NestFactory.create(AppModule, { bodyParser: false });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const express = require('express');
    app.use(express.json({ limit: '20mb' }));
    app.use(express.urlencoded({ limit: '20mb', extended: true }));
    app.setGlobalPrefix('api');
    app.enableCors({ origin: '*' });
    await app.listen(process.env.PORT ?? 3001);
}
bootstrap();
