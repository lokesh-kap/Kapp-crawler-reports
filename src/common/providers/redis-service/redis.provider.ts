import { Provider } from '@nestjs/common';
import Redis from 'ioredis';
import { RedisService } from './redis.service';

export const REDIS_CONNECTION = 'REDIS_CONNECTION';

export const RedisProvider: Provider = {
  provide: REDIS_CONNECTION,
  useFactory: (redisService: RedisService): Redis => redisService.getClient(),
  inject: [RedisService],
};
