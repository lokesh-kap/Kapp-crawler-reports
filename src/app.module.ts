import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import * as dotenv from 'dotenv';
import { CommonModule } from './common/common.module';
import { ScrapperModule } from './scrapper/scrapper.module';
import { ProviderConfigModule } from './provider-config/provider-config.module';
import { ClientWiseModule } from './client-wise/client-wise.module';
import { ExtractionConfigModule } from './extraction-config/extraction-config.module';

dotenv.config();
@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      username: process.env.DB_USER,
      password: process.env.DB_PASS,
      database: process.env.DB_NAME,
      autoLoadEntities: true,
      synchronize: false,
      logging: false,

      ssl: {
        rejectUnauthorized: false,
      },
      extra: {
        max: 5,                        
        min: 0,                       
        idleTimeoutMillis: 30000,      
        connectionTimeoutMillis: 5000, 
        statement_timeout: 60000,      
      },
    }),

    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    CommonModule,
    ScrapperModule,
    ExtractionConfigModule,
    ProviderConfigModule,
    ClientWiseModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
