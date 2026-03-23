import { Module } from '@nestjs/common';
import { QueueModule } from './providers/queue-service/queue.module';
import { RedisModule } from './providers/redis-service/redis.module';

@Module({
  imports: [RedisModule, QueueModule],
  exports: [RedisModule, QueueModule],
})

export class CommonModule {}