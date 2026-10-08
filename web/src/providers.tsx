import { type ReactNode } from "react";
import { MidenProvider } from "@miden-sdk/react";
import { MidenFiSignerProvider } from "@miden-sdk/miden-wallet-adapter-react";
import { WalletAdapterNetwork } from "@miden-sdk/miden-wallet-adapter-base";
import { APP_NAME, MIDEN_RPC_URL, MIDEN_PROVER } from "@/config";

// MidenProvider runs OUTSIDE the signer provider.
//
// When a signer provider (MidenFiSignerProvider) is an *ancestor* of MidenProvider,
// v0.17 MidenProvider treats it as its external keystore and intentionally does NOT
// create the WebClient until that signer connects (it sees `signerContext.isConnected
// === false` and returns early). With a wallet that hasn't connected — e.g. before the
// user connects, or in any environment without the MidenFi extension — the app would
// then hang forever on "Initializing Miden client…", and even the public counter read
// could never run. (This is undocumented in the migration guide; verified against
// `web-sdk` `packages/react-sdk/src/context/MidenProvider.tsx`.)
//
// This template signs entirely through the local MidenProvider client, not the
// wallet: the increment's two transactions (publish the increment note from a
// persisted local sender, then consume it as the NoAuth counter) are submitted by
// the WebClient itself (see useIncrementCounter), mirroring the project-template
// `increment_count` reference. So we run MidenProvider in local-keystore mode (no
// signer above it → it initializes immediately and the full increment works
// without a connected wallet) and keep MidenFiSignerProvider *inside* it purely to
// expose a wallet connect button for apps that additionally want wallet-signed
// transactions. MidenFiSignerProvider works standalone (it provides its own
// WalletContext + SignerContext; no MultiSignerProvider required).
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    // Keep imported counter state and transaction application in one client.
    // This single-threaded setup was introduced for the v0.16 worker's separate
    // in-memory SMT forests and is retained for this demo. Remote proving keeps
    // proof generation off the main thread (see useIncrementCounter).
    <MidenProvider
      config={{ rpcUrl: MIDEN_RPC_URL, prover: MIDEN_PROVER, useWorker: true }}
      loadingComponent={<div className="loading">Loading Miden WASM...</div>}
    >
      <MidenFiSignerProvider
        appName={APP_NAME}
        network={WalletAdapterNetwork.Testnet}
        autoConnect={false}
      >
        {children}
      </MidenFiSignerProvider>
    </MidenProvider>
  );
}
