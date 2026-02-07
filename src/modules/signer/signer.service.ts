import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Transaction } from '@mysten/sui/transactions';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import {
  Keypair,
  SignatureScheme,
  SignatureWithBytes,
  decodeSuiPrivateKey,
} from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Secp256k1Keypair } from '@mysten/sui/keypairs/secp256k1';
import { Secp256r1Keypair } from '@mysten/sui/keypairs/secp256r1';
import { SponsorGasTransactionDto } from './dto/sponsor-gas-transaction.dto';
import {
  IdentityBalances,
  IdentityBalance,
  LoadedIdentity,
  SignerIdentityRole,
  SignedGasTransaction,
  SupportedNetwork,
} from './interfaces/signer.interfaces';

@Injectable()
export class SignerService implements OnModuleInit {
  private readonly logger = new Logger(SignerService.name);
  private sponsor!: LoadedIdentity;
  private relayer!: LoadedIdentity;
  private suiClient!: SuiGrpcClient;

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit(): Promise<void> {
    this.suiClient = this.buildSuiClient();
    this.sponsor = this.loadIdentity('sponsor', [
      'SUI_SPONSOR_PRIVATE_KEY',
      'SPONSOR_PRIVATE_KEY',
      'SUI_PRIV_KEY',
    ]);
    this.relayer = this.loadIdentity('relayer', [
      'SUI_RELAYER_PRIVATE_KEY',
      'RELAYER_PRIVATE_KEY',
    ]);
  }

  async signGasTransaction(
    dto: SponsorGasTransactionDto,
  ): Promise<SignedGasTransaction> {
    const transaction = this.createTransactionFromKind(dto.transactionBytes);
    transaction.setGasOwner(this.sponsor.address);

    const signature = await this.signWithSponsor(transaction);

    return {
      gasOwner: this.sponsor.address,
      bytes: signature.bytes,
      signature: signature.signature,
    } satisfies SignedGasTransaction;
  }

  async getIdentityBalances(): Promise<IdentityBalances> {
    const coinType =
      this.configService.get<string>('SUI_COIN_TYPE') ?? '0x2::sui::SUI';

    const [sponsorBalance, relayerBalance] = await Promise.all([
      this.fetchBalance(this.sponsor, coinType),
      this.fetchBalance(this.relayer, coinType),
    ]);

    return {
      sponsor: sponsorBalance,
      relayer: relayerBalance,
    } satisfies IdentityBalances;
  }

  private async signWithSponsor(
    transaction: Transaction,
  ): Promise<SignatureWithBytes> {
    try {
      return await transaction.sign({
        signer: this.sponsor.keypair,
        client: this.suiClient,
      });
    } catch (error) {
      this.logger.error('Failed to sign gas transaction with sponsor identity');
      throw new BadRequestException(
        'Unable to sponsor gas for the provided transaction.',
      );
    }
  }

  private createTransactionFromKind(serialized: string): Transaction {
    try {
      return Transaction.fromKind(serialized);
    } catch (error) {
      this.logger.warn('Received invalid transaction bytes for sponsorship');
      throw new BadRequestException(
        'transactionBytes must be valid base64-encoded transaction kind bytes.',
      );
    }
  }

  private async fetchBalance(
    identity: LoadedIdentity,
    coinType: string,
  ): Promise<IdentityBalance> {
    try {
      const { balance } = await this.suiClient.core.getBalance({
        owner: identity.address,
        coinType,
      });

      return {
        role: identity.role,
        address: identity.address,
        totalBalance: balance.balance ?? '0',
        coinType: balance.coinType ?? coinType,
      };
    } catch (error) {
      this.logger.error(
        `Failed to fetch balance for ${identity.role} at ${identity.address}`,
      );
      throw new BadRequestException(
        `Unable to retrieve balance for ${identity.role}.`,
      );
    }
  }

  private loadIdentity(
    role: SignerIdentityRole,
    envKeys: string[],
  ): LoadedIdentity {
    const rawKey = this.readFirstPresentEnv(envKeys);
    const keypair = this.createKeypairFromSecret(rawKey, role);
    const address = keypair.toSuiAddress();

    return { role, keypair, address } satisfies LoadedIdentity;
  }

  private createKeypairFromSecret(
    value: string,
    role: SignerIdentityRole,
  ): Keypair {
    try {
      const parsed = decodeSuiPrivateKey(value);
      return this.instantiateKeypair(parsed.scheme, parsed.secretKey);
    } catch (error) {
      this.logger.error(`Invalid ${role} private key provided.`);
      throw new BadRequestException(
        `${role} private key is invalid or malformed.`,
      );
    }
  }

  private instantiateKeypair(
    scheme: SignatureScheme,
    secretKey: Uint8Array,
  ): Keypair {
    switch (scheme) {
      case 'ED25519':
        return Ed25519Keypair.fromSecretKey(secretKey);
      case 'Secp256k1':
        return Secp256k1Keypair.fromSecretKey(secretKey);
      case 'Secp256r1':
        return Secp256r1Keypair.fromSecretKey(secretKey);
      default:
        throw new BadRequestException(
          `Unsupported signature scheme for ${scheme}.`,
        );
    }
  }

  private buildSuiClient(): SuiGrpcClient {
    const networkValue = this.readRequiredEnv<string>('SUI_NETWORK');
    const network = this.validateNetwork(networkValue);
    const baseUrl = this.readRequiredEnv<string>('SUI_GRPC_URL');

    return new SuiGrpcClient({ network, baseUrl });
  }

  private validateNetwork(network: string): SupportedNetwork {
    const supported: SupportedNetwork[] = [
      'mainnet',
      'testnet',
      'devnet',
      'localnet',
    ];

    if (!supported.includes(network as SupportedNetwork)) {
      throw new Error(
        `Unsupported Sui network "${network}". Use one of ${supported.join(', ')}.`,
      );
    }

    return network as SupportedNetwork;
  }

  private readRequiredEnv<T = string>(key: string): T {
    const value = this.configService.get<T>(key);
    if (!value) {
      throw new Error(`Missing required environment variable ${key}.`);
    }
    return value;
  }

  private readFirstPresentEnv(keys: string[]): string {
    for (const key of keys) {
      const value = this.configService.get<string>(key);
      if (value) {
        return value;
      }
    }

    throw new Error(
      `Missing required environment variable. Provide one of: ${keys.join(', ')}.`,
    );
  }
}
