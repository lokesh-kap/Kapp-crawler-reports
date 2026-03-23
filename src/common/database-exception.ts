import {
    ExceptionFilter,
    Catch,
    ArgumentsHost,
    HttpStatus,
  } from '@nestjs/common';
  import { Response } from 'express';
  import { QueryFailedError, EntityNotFoundError, TypeORMError } from 'typeorm';
  
  @Catch(QueryFailedError, EntityNotFoundError, TypeORMError)
  export class DatabaseExceptionFilter implements ExceptionFilter {
    catch(exception: any, host: ArgumentsHost) {
      const ctx = host.switchToHttp();
      const response = ctx.getResponse<Response>();
  
      let status = HttpStatus.INTERNAL_SERVER_ERROR;
      let message = 'Database error occurred';
  
      // Handle PostgreSQL constraint violations
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
      }
      // Handle foreign key violations
      else if (exception.code === '23503') {
        status = HttpStatus.BAD_REQUEST;
        message = 'Referenced record does not exist';
      }
      // Handle not null violations
      else if (exception.code === '23502') {
        status = HttpStatus.BAD_REQUEST;
        message = 'Required field is missing';
      }
      // Handle check constraint violations
      else if (exception.code === '23514') {
        status = HttpStatus.BAD_REQUEST;
        message = 'Data validation failed';
      }
      // Handle entity not found
      else if (exception instanceof EntityNotFoundError) {
        status = HttpStatus.NOT_FOUND;
        message = 'Record not found';
      }
  
      const errorResponse = {
        statusCode: status,
        message,
        error: 'Database Error',
        timestamp: new Date().toISOString(),
        path: ctx.getRequest().url,
      };
  
      // Log the error for debugging (in development)
      if (process.env.NODE_ENV === 'development') {
        console.error('Database Exception:', {
          code: exception.code,
          detail: exception.detail,
          message: exception.message,
          query: exception.query,
          parameters: exception.parameters,
        });
      }
  
      response.status(status).json(errorResponse);
    }
  }
  