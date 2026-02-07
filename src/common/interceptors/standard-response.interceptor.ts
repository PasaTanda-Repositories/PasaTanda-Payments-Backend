import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

interface StandardResponse {
  success: boolean;
  data: unknown;
  message: string;
}

@Injectable()
export class StandardResponseInterceptor implements NestInterceptor {
  intercept(
    _context: ExecutionContext,
    next: CallHandler,
  ): Observable<StandardResponse> {
    return next.handle().pipe(
      map((data) => {
        if (data && typeof data === 'object' && 'success' in data) {
          return data as StandardResponse;
        }

        return {
          success: true,
          data,
          message: 'ok',
        } satisfies StandardResponse;
      }),
    );
  }
}
