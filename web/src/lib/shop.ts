// The Gamecoin shop. Anyone holding Gamecoin may post a sale note (GQ's: the standard PSWAP, which fills
// bit by bit, plus "anyone but the seller names an amount", masm/sale/sale.masm): it offers Gamecoin and
// asks the chain's fee asset; each buy pays the note's creator and leaves the rest on sale. The game
// takes any sale note at or under GC_PRICE, cheapest first. Standard PSWAP notes are not taken: a buyer's
// Bread lists their leftover, and a tap on it buys all of it (wallet#1952).
// ponytail: the 100 GC cap is the screen's; the note itself has a floor per fill, never a ceiling.

import { AccountId, Felt, Note, NoteScript } from "@miden-sdk/miden-sdk";
import { GC_DECIMALS, GC_FAUCET, GC_PRICE } from "@/config";
import { loadScripts, tagScanner, tip } from "./chain";

export type Sale = {
  id: string;
  creator: string;
  gcFaucet: string;
  payFaucet: string;
  /** Gamecoin left on sale (base units) */
  offered: bigint;
  /** what buying all of it costs (base units of the pay asset) */
  asked: bigint;
  /** the least one buy may pay (0: none); the note clamps it to `asked` */
  minFill: bigint;
};

const ONE_GC = 10n ** BigInt(GC_DECIMALS);

/** A sale note the game buys from: Gamecoin for `payFaucet`, at or under GC_PRICE per Gamecoin. */
export function acceptSale(s: Sale, payFaucet: string): boolean {
  return s.gcFaucet === GC_FAUCET && s.payFaucet === payFaucet && s.offered > 0n && s.asked > 0n && s.asked * ONE_GC <= GC_PRICE * s.offered;
}

/** What `gc` Gamecoin cost at this sale's price, rounded up to the base unit. */
export const payFor = (gc: bigint, s: Sale): bigint => (gc * s.asked + s.offered - 1n) / s.offered;

/**
 * The sale `buyer` buys `gc` from: enough left and a floor the buy clears; the cheapest, then the largest.
 * Never the buyer's own: a creator consuming its sale note takes the remainder back instead of paying.
 */
export function pickSale(sales: Sale[], gc: bigint, buyer?: string): Sale | undefined {
  const fits = sales.filter((s) => s.creator !== buyer && s.offered >= gc && payFor(gc, s) >= (s.minFill < s.asked ? s.minFill : s.asked));
  // price a/o < b/o': a * o' < b * o
  fits.sort((a, b) => Number(a.asked * b.offered - b.asked * a.offered) || Number(b.offered - a.offered));
  return fits[0];
}

/**
 * The tag every public sale note of this pair carries, GQ's as the standard's (miden-standards PswapNote::create_tag):
 * note type (2 bits), 14 bits of the PSWAP script root, the top byte of each faucet's prefix.
 */
export function pswapTag(payFaucet: string): number {
  const root = NoteScript.pswap().root().toHex();
  const useCase = (parseInt(root.slice(2, 4), 16) << 6) | (parseInt(root.slice(4, 6), 16) >> 2);
  const top = (id: string) => Number(AccountId.fromHex(id).prefix().asInt() >> 56n);
  return ((1 << 30) | (useCase << 16) | (top(GC_FAUCET) << 8) | top(payFaucet)) >>> 0;
}

/** A sale note as the node serves it (`saleRoot`: GQ's sale script); null for any other note under the tag. */
export function decodeSale(id: string, note: Note, saleRoot: string): Sale | null {
  if (note.recipient().script().root().toHex() !== saleRoot) return null;
  const items = note.recipient().storage().items().map((x) => x.asInt());
  const assets = note.assets().fungibleAssets();
  if (items.length !== 7 || assets.length !== 1) return null;
  const [paySuffix, payPrefix, asked, minFill, , creatorSuffix, creatorPrefix] = items;
  return {
    id,
    creator: AccountId.fromPrefixSuffix(new Felt(creatorPrefix), new Felt(creatorSuffix)).toString(),
    gcFaucet: assets[0].faucetId().toString(),
    payFaucet: AccountId.fromPrefixSuffix(new Felt(payPrefix), new Felt(paySuffix)).toString(),
    offered: assets[0].amount(),
    asked,
    minFill,
  };
}

/** One of the seller's own open sale notes; `standard`: a standard PSWAP note, posted before GQ's sale script. */
export type OwnSale = Sale & { standard: boolean };

let scanSales: ReturnType<typeof tagScanner<Sale>> | undefined;
let scanOwn: ReturnType<typeof tagScanner<OwnSale>> | undefined;

/** The open sale notes the game buys from, read from the node (public notes under the pair's tag). */
export async function openSales(payFaucet: string): Promise<Sale[]> {
  scanSales ??= tagScanner<Sale>(pswapTag(payFaucet));
  const { saleRoot } = await loadScripts();
  const sales = await scanSales(await tip(), (input, id) => {
    const sale = decodeSale(id, input.note(), saleRoot);
    return sale && acceptSale(sale, payFaucet) ? sale : null;
  });
  return sales.filter((s) => !s.consumed);
}

/**
 * `seller`'s open Gamecoin sale notes, GQ's and standard PSWAP ones, for the admin to take back one by one. Bread
 * lists only the sale note the seller posted; every leftover is posted by its buyer's transaction.
 */
export async function ownSales(payFaucet: string, seller: string): Promise<OwnSale[]> {
  scanOwn ??= tagScanner<OwnSale>(pswapTag(payFaucet));
  const { saleRoot } = await loadScripts();
  const pswapRoot = NoteScript.pswap().root().toHex();
  const sales = await scanOwn(await tip(), (input, id) => {
    const ours = decodeSale(id, input.note(), saleRoot);
    const sale = ours ?? decodeSale(id, input.note(), pswapRoot);
    return sale && { ...sale, standard: !ours };
  });
  return sales.filter((s) => !s.consumed && s.creator === seller && s.gcFaucet === GC_FAUCET);
}
