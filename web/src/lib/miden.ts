import { AccountId, Felt, Word } from "@miden-sdk/miden-sdk";

export const parseAccountId = (id: string) =>
  id.startsWith("0x") ? AccountId.fromHex(id) : AccountId.fromBech32(id);

/** Generate a random 4-felt Word (used as note serial number). */
export function randomWord(): Word {
  const felts = Array.from({ length: 4 }, () =>
    new Felt(BigInt(Math.floor(Math.random() * 2 ** 32))),
  );
  return Word.newFromFelts(felts);
}
