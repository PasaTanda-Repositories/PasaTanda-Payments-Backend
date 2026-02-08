import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { SignerService } from './signer.service';
import { SponsorGasTransactionDto } from './dto/sponsor-gas-transaction.dto';

@ApiTags('Signer')
@ApiSecurity('internal-api-key')
@Controller('signer')
export class SignerController {
  constructor(private readonly signerService: SignerService) {}

  @Post('sponsor-gas')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Sign a transaction with the sponsor gas identity without executing it.',
  })
  @ApiOkResponse({ description: 'Transaction signed by sponsor identity.' })
  sponsorGas(@Body() dto: SponsorGasTransactionDto) {
    return this.signerService.signGasTransaction(dto);
  }

  @Get('identities')
  @ApiOperation({
    summary:
      'Return public addresses and balances for sponsor and relayer identities.',
  })
  @ApiOkResponse({
    description: 'Current addresses and balances for configured identities.',
  })
  getIdentities() {
    return this.signerService.getIdentityBalances();
  }
}
