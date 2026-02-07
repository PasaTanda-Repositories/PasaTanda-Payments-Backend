import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';

interface ErrorResponse {
  success: false;
  error: string;
  message: string;
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();

    const { status, error, message } = this.normalizeException(exception);

    const payload: ErrorResponse = {
      success: false,
      error,
      message,
    };

    response.status(status).json(payload);
  }

  private normalizeException(exception: unknown): {
    status: number;
    error: string;
    message: string;
  } {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const res = exception.getResponse();

      if (typeof res === 'string') {
        return { status, error: exception.name, message: res };
      }

      if (res && typeof res === 'object') {
        const body = res as Record<string, unknown>;
        const message = this.stringifyMessage(body.message ?? body.error);
        const error = this.stringifyMessage(body.error ?? exception.name);
        return { status, error, message };
      }

      return { status, error: exception.name, message: exception.message };
    }

    this.logger.error('Unhandled exception', exception as Error);

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      error: 'InternalServerError',
      message: 'Unexpected error occurred.',
    };
  }

  private stringifyMessage(value: unknown): string {
    if (Array.isArray(value)) {
      return value.map((item) => String(item)).join(', ');
    }

    if (value === undefined || value === null) {
      return 'Unexpected error occurred.';
    }

    return String(value);
  }
}
