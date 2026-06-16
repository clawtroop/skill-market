import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
  HttpException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import {
  SkillMarketCatalogError,
  SkillMarketConfigError,
  SkillMarketNotFoundError,
  SkillMarketValidationError,
} from './skill-market.errors';

/**
 * Map domain errors to proper HTTP codes.
 * Core service stays framework-agnostic.
 */
@Catch(SkillMarketNotFoundError, SkillMarketValidationError, SkillMarketCatalogError, SkillMarketConfigError)
export class SkillMarketExceptionFilter implements ExceptionFilter {
  catch(exception: Error, host: ArgumentsHost): void {
    const http = toHttpException(exception);
    const response = host.switchToHttp().getResponse();
    response.status(http.getStatus()).json(http.getResponse());
  }
}

function toHttpException(error: Error): HttpException {
  if (error instanceof SkillMarketNotFoundError) return new NotFoundException(error.message);
  if (error instanceof SkillMarketValidationError) return new BadRequestException(error.message);
  if (error instanceof SkillMarketCatalogError) return new BadRequestException(error.message);
  return new InternalServerErrorException(error.message);
}
