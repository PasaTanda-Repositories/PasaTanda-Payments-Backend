import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Transaction } from '@mysten/sui/transactions';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import type {
  Keypair,
  SignatureScheme,
  SignatureWithBytes,
} from '@mysten/sui/cryptography';
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
  private sdkModulesPromise?: Promise<SuiSdkModules>;

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit(): Promise<void> {
    this.suiClient = await this.buildSuiClient();
    this.sponsor = await this.loadIdentity('sponsor', [
      'SUI_SPONSOR_PRIVATE_KEY',
      'SPONSOR_PRIVATE_KEY',
      'SUI_PRIV_KEY',
    ]);
    this.relayer = await this.loadIdentity('relayer', [
      'SUI_RELAYER_PRIVATE_KEY',
      'RELAYER_PRIVATE_KEY',
    ]);
  }

  async signGasTransaction(
    dto: SponsorGasTransactionDto,
  ): Promise<SignedGasTransaction> {
    const transaction = await this.createTransactionFromKind(
      dto.transactionBytes,
    );
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
      this.logger.error(
        'Failed to sign gas transaction with sponsor identity',
        error instanceof Error ? error.stack : String(error),
      );
      throw new BadRequestException(
        'Unable to sponsor gas for the provided transaction.',
      );
    }
  }

  private async createTransactionFromKind(
    serialized: string,
  ): Promise<Transaction> {
    const { Transaction } = await this.loadSdkModules();
    try {
      return Transaction.fromKind(serialized);
    } catch (error) {
      this.logger.warn(
        'Received invalid transaction bytes for sponsorship',
        error instanceof Error ? error.stack : String(error),
      );
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
        error instanceof Error ? error.stack : String(error),
      );
      throw new BadRequestException(
        `Unable to retrieve balance for ${identity.role}.`,
      );
    }
  }

  private async loadIdentity(
    role: SignerIdentityRole,
    envKeys: string[],
  ): Promise<LoadedIdentity> {
    const rawKey = this.readFirstPresentEnv(envKeys);
    const keypair = await this.createKeypairFromSecret(rawKey, role);
    const address = keypair.toSuiAddress();

    return { role, keypair, address } satisfies LoadedIdentity;
  }

  private async createKeypairFromSecret(
    value: string,
    role: SignerIdentityRole,
  ): Promise<Keypair> {
    const { decodeSuiPrivateKey } = await this.loadSdkModules();
    try {
      const parsed = decodeSuiPrivateKey(value);
      return this.instantiateKeypair(parsed.scheme, parsed.secretKey);
    } catch (error) {
      this.logger.error(
        `Invalid ${role} private key provided.`,
        error instanceof Error ? error.stack : String(error),
      );
      throw new BadRequestException(
        `${role} private key is invalid or malformed.`,
      );
    }
  }

  private async instantiateKeypair(
    scheme: SignatureScheme,
    secretKey: Uint8Array,
  ): Promise<Keypair> {
    const { Ed25519Keypair, Secp256k1Keypair, Secp256r1Keypair } =
      await this.loadSdkModules();
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

  private async buildSuiClient(): Promise<SuiGrpcClient> {
    const networkValue = this.readRequiredEnv<string>('SUI_NETWORK');
    const network = this.validateNetwork(networkValue);
    const baseUrl = this.readRequiredEnv<string>('SUI_GRPC_URL');

    const { SuiGrpcClient } = await this.loadSdkModules();
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

  private async loadSdkModules(): Promise<SuiSdkModules> {
    if (!this.sdkModulesPromise) {
      this.sdkModulesPromise = this.importSdkModules();
    }

    return this.sdkModulesPromise;
  }

  private async importSdkModules(): Promise<SuiSdkModules> {
    const [transactions, grpc, cryptography, ed25519, secp256k1, secp256r1] =
      await Promise.all([
        import('@mysten/sui/transactions'),
        import('@mysten/sui/grpc'),
        import('@mysten/sui/cryptography'),
        import('@mysten/sui/keypairs/ed25519'),
        import('@mysten/sui/keypairs/secp256k1'),
        import('@mysten/sui/keypairs/secp256r1'),
      ]);

    return {
      Transaction: transactions.Transaction,
      SuiGrpcClient: grpc.SuiGrpcClient,
      decodeSuiPrivateKey: cryptography.decodeSuiPrivateKey,
      Secp256k1Keypair: secp256k1.Secp256k1Keypair,
      Secp256r1Keypair: secp256r1.Secp256r1Keypair,
      Ed25519Keypair: ed25519.Ed25519Keypair,
    } satisfies SuiSdkModules;
  }
}

type SuiSdkModules = {
  Transaction: typeof import('@mysten/sui/transactions').Transaction;
  SuiGrpcClient: typeof import('@mysten/sui/grpc').SuiGrpcClient;
  decodeSuiPrivateKey: typeof import('@mysten/sui/cryptography').decodeSuiPrivateKey;
  Ed25519Keypair: typeof import('@mysten/sui/keypairs/ed25519').Ed25519Keypair;
  Secp256k1Keypair: typeof import('@mysten/sui/keypairs/secp256k1').Secp256k1Keypair;
  Secp256r1Keypair: typeof import('@mysten/sui/keypairs/secp256r1').Secp256r1Keypair;
};
