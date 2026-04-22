import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { QueryFailedError, EntityNotFoundError, TypeORMError } from 'typeorm';

const dbExceptionLogger = new Logger('DatabaseExceptionFilter');

@Catch(QueryFailedError, EntityNotFoundError, TypeORMError)
export class DatabaseExceptionFilter implements ExceptionFilter {
  catch(exception: any, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Database error occurred';

    if (exception.code === '23505') {
      status = HttpStatus.CONFLICT;
      if (exception.detail && exception.detail.includes('email')) {
        message = 'Email already exists';
      } else if (exception.detail && exception.detail.includes('phone_number')) {
        message = 'Phone number already exists';
      } else if (exception.detail && exception.detail.includes('name')) {
        message = 'Name already exists';
      } else {
        message = 'Duplicate entry found';
      }
    } else if (exception.code === '23503') {
      status = HttpStatus.BAD_REQUEST;
      message = 'Referenced record does not exist';
    } else if (exception.code === '23502') {
      status = HttpStatus.BAD_REQUEST;
      message = 'Required field is missing';
    } else if (exception.code === '23514') {
      status = HttpStatus.BAD_REQUEST;
      message = 'Data validation failed';
    } else if (exception instanceof EntityNotFoundError) {
      status = HttpStatus.NOT_FOUND;
      message = 'Record not found';
    }

    const errorResponse: Record<string, unknown> = {
      statusCode: status,
      message,
      error: 'Database Error',
      timestamp: new Date().toISOString(),
      path: ctx.getRequest().url,
    };

    dbExceptionLogger.error(
      `${exception.message}${exception.detail ? ` — ${exception.detail}` : ''}`,
      exception.stack,
    );

    const exposeDetails =
      process.env.NODE_ENV !== 'production' || process.env.API_VERBOSE_ERRORS === 'true';
    if (exposeDetails) {
      errorResponse.driverError = exception.message;
      if (exception.detail) errorResponse.detail = exception.detail;
      if (exception.code) errorResponse.code = exception.code;
    }

    response.status(status).json(errorResponse);
  }
}
