import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SignerController } from './signer.controller';
import { SignerService } from './signer.service';

@Module({
  imports: [ConfigModule],
  controllers: [SignerController],
  providers: [SignerService],
  exports: [SignerService],
})
export class SignerModule {}
