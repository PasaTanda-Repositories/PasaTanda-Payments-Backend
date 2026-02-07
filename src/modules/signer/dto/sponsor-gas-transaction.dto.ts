import { ApiProperty } from '@nestjs/swagger';
import { IsBase64, IsNotEmpty } from 'class-validator';

export class SponsorGasTransactionDto {
  @ApiProperty({
    description:
      'Base64-encoded transaction kind bytes built with onlyTransactionKind.',
    example: 'AAACAQ...',
  })
  @IsBase64()
  @IsNotEmpty()
  transactionBytes!: string;
}
