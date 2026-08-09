import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  NotFoundException,
} from '@nestjs/common';
import { EntityNotFoundError } from 'typeorm';

@Catch(EntityNotFoundError)
export class EntityNotFoundExceptionFilter implements ExceptionFilter {
  catch(exception: EntityNotFoundError, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();
    const request = ctx.getRequest();

    // Extract entity name from the error
    const entityName = (exception.entityClass as any)?.name || 'Entity';

    const notFoundException = new NotFoundException(`${entityName} not found`);

    response.status(404).json({
      statusCode: 404,
      message: notFoundException.message,
      error: 'Not Found',
      timestamp: new Date().toISOString(),
      path: request.url,
    });
  }
}
