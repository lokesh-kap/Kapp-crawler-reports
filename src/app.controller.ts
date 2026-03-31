import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { AppService } from './app.service';
import { RedisService } from './common/providers/redis-service/redis.service';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly redisService: RedisService,
  ) {}

  @Get()
  getHello() {
    return this.appService.getHello();
  }

  @Get('health')
  async health() {
    try {
      const pong = await this.redisService.getClient().ping();
      if (pong !== 'PONG') {
        throw new Error(`Unexpected PING reply: ${String(pong)}`);
      }
      return { status: 'ok', redis: 'connected' };
    } catch {
      throw new ServiceUnavailableException({
        status: 'error',
        redis: 'unavailable',
      });
    }
  }
}
