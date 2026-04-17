import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

/**
 * Owns the Redis connection and closes it on module destroy.
 * Prevents orphaned connections and listeners on hot-reload (watch mode).
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly redis: Redis;

  constructor() {
    this.redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
      maxRetriesPerRequest: 0, // Stop BullMQ from blocking startup
      enableReadyCheck: false,
      lazyConnect: true, // Don't connect until used
      retryStrategy: (times) => {
        // Only retry every 30 seconds to keep logs clean
        return Math.min(times * 50, 30000);
      }
    });

    this.redis.on('error', (err) => {
      // Log as a warning instead of a crash-inducing error
      if ((err as any).code === 'ECONNREFUSED') {
        // Silent warning for dev
      } else {
        console.error('Redis connection error:', err);
      }
    });

    this.redis.on('connect', () => {
      console.log('✅ Redis connected successfully');
    });
  }

  getClient(): Redis {
    return this.redis;
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }
}
