import { Global, Module } from '@nestjs/common';
import { RedisProvider } from './redis.provider';
import { RedisService } from './redis.service';

@Global()
@Module({
  providers: [RedisService, RedisProvider],
  exports: [RedisService, RedisProvider],
})
export class RedisModule {}
