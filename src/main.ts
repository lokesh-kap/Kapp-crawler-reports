import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger, ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { DatabaseExceptionFilter } from './common/database-exception';
import * as bodyParser from 'body-parser';

/** Split comma-separated URLs (e.g. FRONTEND_URL) into trimmed non-empty strings. */
function parseCommaSeparatedUrls(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(',')
    .map((u) => u.trim())
    .filter((u) => u.length > 0);
}

async function bootstrap() {

  const app = await NestFactory.create(AppModule);

  app.use(bodyParser.json({ limit: '50mb' }));
  app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));

  app.useGlobalPipes(new ValidationPipe({
    transform: true,
    transformOptions: {
      enableImplicitConversion: true,
    },
  }));
  
  app.use(cookieParser());

  app.useGlobalFilters(new DatabaseExceptionFilter());

  const allowedOrigins = [
    ...parseCommaSeparatedUrls(process.env.ALLOWED_ORIGINS),
  ];

  app.enableCors({
    origin: (origin, callback) => {
    if (!origin) {
        return callback(null, true);
      }

      // Allow whitelisted origins
      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      // Allow requests from kapp1.com (your short URL domain)
      if (origin.includes('kapp1.com')) {
        return callback(null, true);
      }

      // Allow requests from kollegeapply.com subdomains
      if (origin.includes('kollegeapply.com')) {
        return callback(null, true);
      }

      // Block everything else
      callback(new Error('Not allowed by CORS'));
    },
    methods: "GET,HEAD,PUT,PATCH,POST,DELETE",
    credentials: true,
    allowedHeaders: ["Authorization", "Content-Type" , "Accept", "Accept-Language", "X-Requested-With"],
  });


  await app.listen(process.env.PORT ?? 9002);
  Logger.log(`Server is running on port ${process.env.PORT ?? 9002}`);
}
bootstrap();
