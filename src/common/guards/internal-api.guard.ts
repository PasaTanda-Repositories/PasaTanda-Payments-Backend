import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';

@Injectable()
export class InternalApiGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const expectedKey = this.configService.get<string>('INTERNAL_API_KEY');
    const receivedKey =
      (request.headers['x-internal-api-key'] as string | undefined) ??
      (request.headers['internal-api-key'] as string | undefined);

    if (!expectedKey) {
      throw new UnauthorizedException('Internal API key is not configured.');
    }

    if (!receivedKey || receivedKey !== expectedKey) {
      throw new UnauthorizedException('Unauthorized access.');
    }

    return true;
  }
}
