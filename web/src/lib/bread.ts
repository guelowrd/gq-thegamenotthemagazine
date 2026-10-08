// Building transactions for Bread to sign. Bread accounts are guarded multisigs; a request for one
// must carry the multisig auth args (bound block, salt, fee conversion info) and declare the bound
// block. The SDK's fee-aware builder only does that for accounts in the dApp's own store, which a
// private Bread account never is, so the words are rebuilt here (mirror of
// integration/src/auth_args.rs, pinned by rules/auth_vectors.json).

import {
  AccountId,
  AdviceMap,
  Felt,
  NoteAndArgs,
  NoteAndArgsArray,
  NoteArray,
  Poseidon2,
  TransactionRequestBuilder,
  Word,
  type TransactionRequest,
} from "@miden-sdk/miden-sdk";
import { Transaction } from "@miden-sdk/miden-wallet-adapter-base";
import type { useMidenFiWallet } from "@miden-sdk/miden-wallet-adapter-react";
import { buildGqNote, fetchNotesWithProof, feltArray, loadScripts, parseAccountId, type Client, type GqNote } from "./chain";
import { challengeStorage, encodeStorage, type AccountFelts, type ChallengeStorage } from "./notes";
import { randomSeed, type Word4 } from "./quiz";
import authVectors from "../../../rules/auth_vectors.json";

type Wallet = ReturnType<typeof useMidenFiWallet>;

/** The 12 felts a multisig account reads from its auth args (miden-standards `MultisigAuthArgs`). */
export function authArgElements(boundBlock: number, salt: Word4, feeFaucet: { suffix: bigint; prefix: bigint }): bigint[] {
  return [
    BigInt(boundBlock),
    0n, // no approval expiration
    0n,
    0n,
    ...salt,
    feeFaucet.suffix,
    feeFaucet.prefix,
    1n, // one-to-one fee conversion
    1n,
  ];
}

export function multisigAuthArgs(boundBlock: number, salt: Word4, feeFaucet: AccountId): { elements: bigint[]; commitment: Word } {
  const elements = authArgElements(boundBlock, salt, { suffix: feeFaucet.suffix().asInt(), prefix: feeFaucet.prefix().asInt() });
  return { elements, commitment: Poseidon2.hashElements(feltArray(elements)) };
}

/** Development check: the browser-side commitment must equal the Rust reference's. */
export function selfCheckAuthArgs(): void {
  for (const v of authVectors) {
    const salt = v.salt.map(BigInt) as Word4;
    const { commitment } = multisigAuthArgs(v.bound_block, salt, AccountId.fromHex(v.fee_faucet));
    if (commitment.toHex() !== v.commitment) {
      console.error("[gq] multisig auth-arg commitment differs from the Rust reference", commitment.toHex(), v.commitment);
    } else {
      console.info("[gq] multisig auth-arg commitment matches the Rust reference");
    }
  }
}

/** A request builder carrying the auth args Bread's multisig needs, bound to the current tip. */
async function breadBuilder(client: Client): Promise<TransactionRequestBuilder> {
  const feeFaucet = await client.feeFaucetId();
  const boundBlock = await client.getSyncHeight();
  const { elements, commitment } = multisigAuthArgs(boundBlock, randomSeed(), feeFaucet);
  const advice = new AdviceMap();
  advice.insert(commitment, feltArray(elements));
  return new TransactionRequestBuilder().withAuthArg(commitment).extendAdviceMap(advice).withBlockNumbers([boundBlock]);
}

async function submit(wallet: Wallet, request: TransactionRequest, inputNoteIds?: string[], importNotes?: Uint8Array[]): Promise<string> {
  if (!wallet.address || !wallet.requestTransaction) throw new Error("Bread is not connected");
  const tx = Transaction.createCustomTransaction(wallet.address, wallet.address, request, inputNoteIds, importNotes);
  return wallet.requestTransaction(tx);
}

/** Champion: post a prize note. `storage.challengeRoot` is filled from the loaded script. */
export async function postPrize(client: Client, wallet: Wallet, storage: ChallengeStorage, amount: bigint): Promise<string> {
  const { prize, challenge } = await loadScripts();
  const root = challenge.root().toFelts().map((f) => f.asInt()) as Word4;
  const note = buildGqNote(parseAccountId(wallet.address!), prize, encodeStorage({ ...storage, challengeRoot: root }), amount);
  const notes = new NoteArray();
  notes.push(note);
  const request = (await breadBuilder(client)).withOwnOutputNotes(notes).build();
  return submit(wallet, request);
}

/** Challenger: post a challenge note bound to `prize`, staking `prize.storage.minStake`. */
export async function postChallenge(client: Client, wallet: Wallet, prize: GqNote, me: AccountFelts): Promise<string> {
  const { challenge } = await loadScripts();
  const storage = challengeStorage(prize.storage, me, prize.idWord);
  const note = buildGqNote(parseAccountId(wallet.address!), challenge, encodeStorage(storage), prize.storage.minStake);
  const notes = new NoteArray();
  notes.push(note);
  const request = (await breadBuilder(client)).withOwnOutputNotes(notes).build();
  return submit(wallet, request);
}

/**
 * Settle a challenge with the player's answers; when `prize` is given, claim it in the same
 * transaction. The notes travel with their inclusion proofs so Bread needs no prior sync of them.
 */
export async function settle(client: Client, wallet: Wallet, challenge: GqNote, prize: GqNote | undefined, answer: Word4): Promise<string> {
  const ids = prize ? [prize.id, challenge.id] : [challenge.id];
  const { inputs, files } = await fetchNotesWithProof(ids);
  const arg = Word.newFromFelts(feltsOf(answer));
  let builder = await breadBuilder(client);
  for (const input of inputs) builder = builder.withExplicitInputNote(input, arg);
  return submit(wallet, builder.build(), ids, files);
}

/** Champion after expiry: reclaim a prize note or collect a forfeited challenge stake. */
export async function collect(client: Client, wallet: Wallet, note: GqNote): Promise<string> {
  const { inputs, files } = await fetchNotesWithProof([note.id]);
  const builder = (await breadBuilder(client)).withExplicitInputNote(inputs[0], Word.newFromFelts(feltsOf([0n, 0n, 0n, 0n])));
  return submit(wallet, builder.build(), [note.id], files);
}

function feltsOf(w: Word4): Felt[] {
  return w.map((v) => new Felt(v));
}

// keep the unused-import linter honest about the types this file relies on
export type { NoteAndArgs, NoteAndArgsArray };
