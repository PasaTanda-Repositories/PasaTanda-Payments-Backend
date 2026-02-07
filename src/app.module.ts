import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { InternalApiGuard } from './common/guards/internal-api.guard';
import { StandardResponseInterceptor } from './common/interceptors/standard-response.interceptor';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { SignerModule } from './modules/signer/signer.module';
import { RelayerModule } from './modules/relayer/relayer.module';
import { ArcModule } from './modules/arc/arc.module';
import { FiatModule } from './modules/fiat/fiat.module';
import { StorageModule } from './modules/storage/storage.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    SignerModule,
    RelayerModule,
    ArcModule,
    FiatModule,
    StorageModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: InternalApiGuard },
    { provide: APP_INTERCEPTOR, useClass: StandardResponseInterceptor },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
export class AppModule {}
