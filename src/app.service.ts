import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getHello() {
    return {
      success: true,
      message: `🤖 Hello From LMS Scraper! - ${new Date().toISOString()} 🤖`
    };
  }
}
