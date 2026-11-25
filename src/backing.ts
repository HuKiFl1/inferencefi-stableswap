import type { Amount } from "./types.js";

export interface ChannelBackingInput {
  /** E: total escrow of the channel (lenderPrincipal + payerDeposit). */
  readonly escrow: Amount;
  /** L: principal the pool lent into the channel. */
  readonly lenderPrincipal: Amount;
  /** O: cumulative amount owed to the provider at the latest finalized state. */
  readonly owed: Amount;
}

/**
 * Lender principal the pool would recover if the channel were reclaimed at
 * its latest finalized state. This is `toLender` of the flop-channel-reclaim
 * payout waterfall (Flop SPEC §10): provider first, then lender, then payer.
 *
 *   toProvider  = min(O, E)
 *   recoverable = min(L, E − toProvider)
 *
 * It never exceeds `max(E − O, 0)`, the escrow left after the provider is paid
 * (reclaim invariant R1).
 */
export function recoverablePrincipal({ escrow, lenderPrincipal, owed }: ChannelBackingInput): Amount {
  if (escrow < 0n || owed < 0n || lenderPrincipal < 0n || lenderPrincipal > escrow) {
    throw new RangeError("recoverablePrincipal: require 0 <= lenderPrincipal <= escrow and owed >= 0");
  }
  const toProvider = owed < escrow ? owed : escrow;
  const rest = escrow - toProvider;
  return lenderPrincipal < rest ? lenderPrincipal : rest;
}
