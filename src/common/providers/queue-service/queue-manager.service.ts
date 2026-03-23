import { Injectable, Inject, Logger, OnModuleDestroy } from '@nestjs/common';
import { Queue, JobsOptions, ConnectionOptions } from 'bullmq';
import Redis from 'ioredis';
import { REDIS_CONNECTION } from '../redis-service/redis.provider';
import { QueueConfig } from './interface/queue-config.interface';


@Injectable()
export class QueueManagerService implements OnModuleDestroy {
  private readonly logger = new Logger(QueueManagerService.name);
  private readonly queues = new Map<string, Queue>();
  private readonly connection: ConnectionOptions;

  constructor(
    @Inject(REDIS_CONNECTION) private readonly redis: Redis,
  ) {
    this.connection = this.createConnectionOptions(redis);
  }

  getQueue(name: string, config?: Partial<QueueConfig>): Queue {
    if (this.queues.has(name)) {
      return this.queues.get(name)!;
    }

    return this.createQueue({ name, ...config });
  }


  createQueue(config: QueueConfig): Queue {
    if (this.queues.has(config.name)) {
      this.logger.warn(`Queue "${config.name}" already exists, returning existing instance`);
      return this.queues.get(config.name)!;
    }

    const queue = new Queue(config.name, {
      connection: this.connection,
      defaultJobOptions: config.defaultJobOptions,
    });

    this.queues.set(config.name, queue);
    this.logger.log(`✅ Created queue: ${config.name}`);

    return queue;
  }

  async addJob<T = any>(
    queueName: string,
    jobName: string,
    data: T,
    options?: JobsOptions,
  ): Promise<void> {
    const queue = this.getQueue(queueName);
    await queue.add(jobName, data, options);
  }

  async getQueueStats(queueName: string): Promise<{
    waiting: number;
    active: number;
    completed: number;
    failed: number;
  }> {
    const queue = this.getQueue(queueName);
    const [waiting, active, completed, failed] = await Promise.all([
      queue.getWaitingCount(),
      queue.getActiveCount(),
      queue.getCompletedCount(),
      queue.getFailedCount(),
    ]);

    return { waiting, active, completed, failed };
  }

  async closeAllQueues(): Promise<void> {
    const closePromises = Array.from(this.queues.values()).map((queue) => queue.close());
    await Promise.all(closePromises);
    this.queues.clear();
    this.logger.log('All queues closed');
  }

  async onModuleDestroy(): Promise<void> {
    await this.closeAllQueues();
  }

  getRegisteredQueueNames(): string[] {
    return Array.from(this.queues.keys());
  }

  private createConnectionOptions(redis: Redis): ConnectionOptions {
    const { host, port, username, password, db, tls } = redis.options;

    return {
      host: host ?? '127.0.0.1',
      port: port ?? 6379,
      username,
      password,
      db,
      tls,
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    };
  }
}

