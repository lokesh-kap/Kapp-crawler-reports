import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getHello() {
    return {
      success: true,
      message: `🤖 Hello From KollegeApply LMS Scraper! - ${new Date().toISOString()} 🤖`
    };
  }
}