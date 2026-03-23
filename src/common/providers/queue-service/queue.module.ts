import { Module, Global } from '@nestjs/common';
import { QueueManagerService } from './queue-manager.service';
import { WorkerManagerService } from './worker-manager.service';
import { RedisModule } from '../redis-service/redis.module';

@Global()
@Module({
  imports: [RedisModule],
  providers: [QueueManagerService, WorkerManagerService],
  exports: [QueueManagerService, WorkerManagerService],
})
export class QueueModule {}

