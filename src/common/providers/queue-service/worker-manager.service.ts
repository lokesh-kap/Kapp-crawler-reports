import { Injectable, Inject, Logger, OnModuleDestroy } from '@nestjs/common';
import { Worker, Job, ConnectionOptions } from 'bullmq';
import Redis from 'ioredis';
import { REDIS_CONNECTION } from '../redis-service/redis.provider'
import { WorkerConfig, JobProcessor } from './interface/queue-config.interface';


@Injectable()
export class WorkerManagerService implements OnModuleDestroy {
  private readonly logger = new Logger(WorkerManagerService.name);
  private readonly workers = new Map<string, Worker>();
  private readonly connection: ConnectionOptions;

  constructor(
    @Inject(REDIS_CONNECTION) private readonly redis: Redis,
  ) {
    this.connection = this.createConnectionOptions(redis);
  }

  registerWorker<T = any>(config: WorkerConfig<T>): Worker {
    const { queueName, processor, concurrency = 5, onFailed, onCompleted, onActive, workerOptions } = config;

    // Check if worker already exists
    if (this.workers.has(queueName)) {
      this.logger.warn(`Worker for queue "${queueName}" already exists, returning existing worker`);
      return this.workers.get(queueName)!;
    }

    // Wrap processor to handle errors and logging
    const wrappedProcessor = async (job: Job) => {
      try {
        this.logger.debug(`Processing job ${job.id} from queue ${queueName} (attempt ${job.attemptsMade + 1})`);
        const result = await processor(job);
        return result;
      } catch (error) {
        this.logger.error(`Job ${job.id} failed: ${error.message}`, error.stack);
        throw error; // Re-throw to let BullMQ handle retries
      }
    };

    // Create worker
    const worker = new Worker(
      queueName,
      wrappedProcessor,
      {
        connection: this.connection,
        concurrency,
        ...workerOptions,
      },
    );

    // Register event handlers
    if (onFailed) {
      worker.on('failed', (job, err) => {
        if (job) {
          onFailed(job, err);
        }
      });
    }

    if (onCompleted) {
      worker.on('completed', (job, result) => {
        if (job) {
          onCompleted(job, result);
        }
      });
    }

    if (onActive) {
      worker.on('active', (job) => {
        if (job) {
          onActive(job);
        }
      });
    }

    // Error handling
    worker.on('error', (error) => {
      this.logger.error(`Worker error for queue ${queueName}:`, error);
    });

    this.workers.set(queueName, worker);
    this.logger.log(`✅ Registered worker for queue: ${queueName} (concurrency: ${concurrency})`);

    return worker;
  }

  /**
   * Get an existing worker by queue name
   */
  getWorker(queueName: string): Worker | undefined {
    return this.workers.get(queueName);
  }

  /**
   * Check if a worker exists for a queue
   */
  hasWorker(queueName: string): boolean {
    return this.workers.has(queueName);
  }

  /**
   * Close all workers (useful for graceful shutdown / hot-reload)
   */
  async closeAllWorkers(): Promise<void> {
    const closePromises = Array.from(this.workers.values()).map((worker) => worker.close());
    await Promise.all(closePromises);
    this.workers.clear();
    this.logger.log('All workers closed');
  }

  async onModuleDestroy(): Promise<void> {
    await this.closeAllWorkers();
  }

  /**
   * Close a specific worker
   */
  async closeWorker(queueName: string): Promise<void> {
    const worker = this.workers.get(queueName);
    if (worker) {
      await worker.close();
      this.workers.delete(queueName);
      this.logger.log(`Worker for queue "${queueName}" closed`);
    }
  }

  /**
   * Get all registered worker queue names
   */
  getRegisteredWorkerQueueNames(): string[] {
    return Array.from(this.workers.keys());
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

