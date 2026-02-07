import { Keypair } from '@mysten/sui/cryptography';

export type SignerIdentityRole = 'sponsor' | 'relayer';
export type SupportedNetwork = 'mainnet' | 'testnet' | 'devnet' | 'localnet';

export interface LoadedIdentity {
  role: SignerIdentityRole;
  keypair: Keypair;
  address: string;
}

export interface IdentityBalance {
  role: SignerIdentityRole;
  address: string;
  totalBalance: string;
  coinType: string;
}

export interface IdentityBalances {
  sponsor: IdentityBalance;
  relayer: IdentityBalance;
}

export interface SignedGasTransaction {
  gasOwner: string;
  bytes: string;
  signature: string;
}
