/**
 * The C1 action table, as code.
 *
 * This is the file that makes the assistant safe to ship. The UI must never offer an action the
 * chain would reject, and now the assistant is bound by the same table — bound in **code**, not
 * in the system prompt, because a prompt is a suggestion and a function is not.
 *
 * | Action         | Caller     | Precondition                                              |
 * |----------------|------------|-----------------------------------------------------------|
 * | accept         | freelancer | not accepted, not cancelled, before deadline               |
 * | cancel         | client     | not yet accepted                                           |
 * | submit         | freelancer | accepted, before deadline, state Pending or Submitted      |
 * | attest         | anyone     | state Submitted, submission matches, valid verifier sig    |
 * | approve        | client     | state Submitted or Attested                                |
 * | release        | anyone     | state Attested and challenge window elapsed                |
 * | dispute        | client     | state Submitted or Attested                                |
 * | resolveDispute | arbiter    | state Disputed                                             |
 * | reclaim        | client     | after deadline, state Pending or Submitted                 |
 * | withdraw       | anyone     | owed > 0                                                   |
 *
 * Everything here is pure and total: `permits` is a function of `(action, ctx)` and nothing
 * else. It reads no clock, no network and no environment — `now` arrives in the context. That
 * is what lets the counterparty's free text be structurally incapable of widening the surface:
 * a job title or an evidence note is not an input to this file, so an assistant fully persuaded
 * by an injected instruction can still only emit a card this table already allows for that role.
 */

import {
  MSTATE,
  type ActionContext,
  type ChainAction,
  type JobView,
  type MState,
  type Permission,
  type Role,
} from '@/lib/chat/types'

/** Every action in the table, in table order. `availableActions` reports them in this order. */
export const ALL_ACTIONS: readonly ChainAction[] = [
  'accept',
  'cancel',
  'submit',
  'attest',
  'approve',
  'release',
  'dispute',
  'resolveDispute',
  'reclaim',
  'withdraw',
] as const

/**
 * Actions that name a single milestone. For these, a context without `milestoneState` is not a
 * silent pass — it is a blocked verdict asking which milestone the user means.
 */
export const MILESTONE_SCOPED_ACTIONS: readonly ChainAction[] = [
  'submit',
  'attest',
  'approve',
  'release',
  'dispute',
  'resolveDispute',
  'reclaim',
] as const

/**
 * Actions the assistant may put behind a button.
 *
 * `attest` is the one action that is *permitted but not proposable*. Anyone may call it — that
 * is deliberate, it is how a verifier's opinion reaches the chain — but the call carries a
 * verifier signature over the submission, and the assistant has no verifier key and no way to
 * obtain one. A button labelled "Attest" that the wallet cannot possibly fill in would simulate
 * to a revert and teach the user nothing, so the proposer must never offer it. `permits` still
 * answers honestly about the on-chain precondition, because the read tools need that answer to
 * explain *why* a milestone is waiting on the verifier.
 */
export const NON_PROPOSABLE_ACTIONS: readonly ChainAction[] = ['attest'] as const

/** True when the proposer is allowed to render this action as a button at all. */
export function isProposable(action: ChainAction): boolean {
  return !NON_PROPOSABLE_ACTIONS.includes(action)
}

/** One row of `availableActions`: the verdict plus whether it could ever become a button. */
export type ActionVerdict = {
  action: ChainAction
  permission: Permission
  /** False for `attest` — permitted by the chain, but not something the assistant can offer. */
  proposable: boolean
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

/**
 * Which role a wallet holds on a job.
 *
 * Addresses are compared case-insensitively: EIP-55 checksummed, all-lowercase and all-uppercase
 * spellings of the same address are the same account, and chain data reaches us in all three.
 *
 * **Precedence: client > freelancer > arbiter > stranger.** One address can hold more than one
 * role — a client who names themselves as arbiter is legal on-chain — and the roles disagree
 * about what is allowed, so a total function needs a tie-break. It resolves to the *most
 * economically exposed* role: the client's money is in the escrow, so a client who is also the
 * arbiter is treated as the client, and the assistant will not offer them `resolveDispute`. That
 * is the conservative direction. Losing the arbiter button costs them one manual transaction;
 * gaining it would let the assistant walk a party through resolving their own dispute.
 *
 * The zero address never holds a role. An unaccepted job carries `freelancer = 0x0` and a job
 * with no arbiter carries `arbiter = 0x0`; without this guard a caller passing the zero address
 * would inherit whichever field happened to be unset.
 */
export function roleOf(
  account: string | null | undefined,
  job: Pick<JobView, 'client' | 'freelancer' | 'arbiter'>,
): Role {
  if (!account) return 'stranger'
  const a = account.toLowerCase()
  if (a === ZERO_ADDRESS) return 'stranger'
  if (a === job.client.toLowerCase()) return 'client'
  if (a === job.freelancer.toLowerCase()) return 'freelancer'
  if (a === job.arbiter.toLowerCase()) return 'arbiter'
  return 'stranger'
}

const ALLOW: Permission = { allowed: true }

function deny(reason: string): Permission {
  return { allowed: false, reason }
}

const ROLE_LABEL: Record<Role, string> = {
  client: 'the client',
  freelancer: 'the freelancer',
  arbiter: 'the arbiter',
  stranger: 'not a party to this escrow',
}

const STATE_LABEL: Record<MState, string> = {
  [MSTATE.Pending]: 'Pending',
  [MSTATE.Submitted]: 'Submitted',
  [MSTATE.Attested]: 'Attested',
  [MSTATE.Released]: 'Released',
  [MSTATE.Disputed]: 'Disputed',
  [MSTATE.Refunded]: 'Refunded',
}

/** Human duration, two units at most: "3 days 4 hours", "2 hours", "1 second". */
function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const units: readonly [name: string, size: number][] = [
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
    ['second', 1],
  ]
  const first = units.findIndex(([, size]) => Math.floor(total / size) > 0)
  if (first === -1) return 'less than a second'

  const [bigName, bigSize] = units[first]
  const big = Math.floor(total / bigSize)
  let out = plural(big, bigName)

  const next = units[first + 1]
  if (next) {
    const small = Math.floor((total - big * bigSize) / next[1])
    if (small > 0) out += ` ${plural(small, next[0])}`
  }
  return out
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'}`
}

/** Blocked unless the connected wallet holds `expected`. `phrase` completes "Only X can ___". */
function requireRole(
  expected: Exclude<Role, 'stranger'>,
  actual: Role,
  phrase: string,
): Permission | null {
  if (actual === expected) return null
  return deny(
    `Only ${ROLE_LABEL[expected]} can ${phrase} — this wallet is ${ROLE_LABEL[actual]}. ` +
      `Switch to ${ROLE_LABEL[expected]}'s wallet to do it.`,
  )
}

/**
 * The verdict for a milestone-scoped action asked about no milestone. Keeps `permits` total for
 * partial contexts instead of letting `undefined` fall through as a pass.
 */
function missingMilestone(action: ChainAction): Permission {
  return deny(
    `"${action}" applies to one specific milestone, and this question did not name one. ` +
      `Say which milestone you mean — for example "milestone 2" — and ask again.`,
  )
}

/**
 * Wei, as a `bigint`. Balances routinely exceed `Number.MAX_SAFE_INTEGER`, so `owed` travels as
 * a decimal string and is compared as a `bigint`; `Number(owed) > 0` would be a rounding bug
 * waiting for a large enough escrow. Returns null when the string is not a plain integer, which
 * `withdraw` reports rather than silently reading as zero.
 */
function parseWei(owed: string): bigint | null {
  if (!/^\d+$/.test(owed.trim())) return null
  try {
    return BigInt(owed.trim())
  } catch {
    return null
  }
}

function stateIsOneOf(state: MState, allowed: readonly MState[]): boolean {
  return allowed.includes(state)
}

/**
 * The table, exactly. Total: every `(action, ctx)` pair returns a verdict, and a blocked verdict
 * always carries a reason written for a person — not "precondition failed" but the fact that
 * failed and what to do about it.
 */
export function permits(action: ChainAction, ctx: ActionContext): Permission {
  switch (action) {
    // accept — freelancer; not accepted, not cancelled, before deadline.
    case 'accept': {
      const role = requireRole('freelancer', ctx.role, 'accept this job')
      if (role) return role
      if (ctx.cancelled) {
        return deny(
          'The client cancelled this job before it was accepted, so it can no longer be ' +
            'accepted. Ask them to post it again if the work is still wanted.',
        )
      }
      if (ctx.accepted) {
        return deny(
          'This job has already been accepted — accepting twice would revert. ' +
            'Submit a milestone instead.',
        )
      }
      if (ctx.now >= ctx.deadline) {
        return deny(
          `The deadline passed ${formatDuration(ctx.now - ctx.deadline)} ago, so this job can ` +
            'no longer be accepted. Ask the client to post it again with a later deadline.',
        )
      }
      return ALLOW
    }

    // cancel — client; not yet accepted.
    //
    // The table's precondition is "not yet accepted". The already-cancelled check below is not a
    // second precondition, it is the same one seen from the other side: cancelling burns the
    // job, so a second cancel reverts, and the rule above this whole file is that the UI never
    // offers an action the chain would reject.
    case 'cancel': {
      const role = requireRole('client', ctx.role, 'cancel this job')
      if (role) return role
      if (ctx.cancelled) {
        return deny(
          'This job is already cancelled, so there is nothing left to cancel. ' +
            'Your escrowed funds are refundable — withdraw them.',
        )
      }
      if (ctx.accepted) {
        return deny(
          'The freelancer has already accepted this job, so it can no longer be cancelled. ' +
            'Wait for the milestones, reclaim after the deadline, or open a dispute.',
        )
      }
      return ALLOW
    }

    // submit — freelancer; accepted, before deadline, state Pending or Submitted.
    case 'submit': {
      const role = requireRole('freelancer', ctx.role, 'submit work for this milestone')
      if (role) return role
      const state = ctx.milestoneState
      if (state === undefined) return missingMilestone(action)
      if (!ctx.accepted) {
        return deny(
          'Nobody has accepted this job yet, so there is no milestone to submit against. ' +
            'Accept the job first, then submit.',
        )
      }
      if (!stateIsOneOf(state, [MSTATE.Pending, MSTATE.Submitted])) {
        return deny(
          `This milestone is ${STATE_LABEL[state]}, and only a Pending or Submitted milestone ` +
            'takes a new submission. Pick a milestone that still needs work.',
        )
      }
      // Strictly before: at the deadline second itself, submissions are already closed.
      if (ctx.now >= ctx.deadline) {
        return deny(
          `The deadline passed ${formatDuration(ctx.now - ctx.deadline)} ago and submissions ` +
            'closed with it. Talk to the client before they reclaim the escrow.',
        )
      }
      return ALLOW
    }

    // attest — anyone; state Submitted (plus a matching submission and a valid verifier
    // signature, neither of which is a chain fact this context carries). Permitted, never
    // proposable: see NON_PROPOSABLE_ACTIONS.
    case 'attest': {
      const state = ctx.milestoneState
      if (state === undefined) return missingMilestone(action)
      if (state !== MSTATE.Submitted) {
        return deny(
          `Only a Submitted milestone can be attested, and this one is ${STATE_LABEL[state]}. ` +
            'Wait for the freelancer to submit work before the verifier can attest it.',
        )
      }
      return ALLOW
    }

    // approve — client; state Submitted or Attested.
    case 'approve': {
      const role = requireRole('client', ctx.role, 'approve this milestone')
      if (role) return role
      const state = ctx.milestoneState
      if (state === undefined) return missingMilestone(action)
      if (!stateIsOneOf(state, [MSTATE.Submitted, MSTATE.Attested])) {
        return deny(
          `Approve pays out a Submitted or Attested milestone, and this one is ` +
            `${STATE_LABEL[state]}. Wait for the freelancer to submit work you can approve.`,
        )
      }
      return ALLOW
    }

    // release — ANYONE; state Attested and the challenge window elapsed.
    //
    // Deliberately not gated by role. That is the point of the design: once a milestone is
    // attested and its challenge window has run out, any wallet can push the payment through,
    // so the freelancer never has to chase the client for a signature.
    case 'release': {
      const state = ctx.milestoneState
      if (state === undefined) return missingMilestone(action)
      if (state !== MSTATE.Attested) {
        return deny(
          `Release only pays out an Attested milestone, and this one is ${STATE_LABEL[state]}. ` +
            'The verifier has to attest the submission before the challenge window can start.',
        )
      }
      if (ctx.now < ctx.releasableAt) {
        return deny(
          `The challenge window still has ${formatDuration(ctx.releasableAt - ctx.now)} left, ` +
            'during which the client can dispute. After that anyone can call release, ' +
            'including you.',
        )
      }
      return ALLOW
    }

    // dispute — client; state Submitted or Attested.
    case 'dispute': {
      const role = requireRole('client', ctx.role, 'dispute this milestone')
      if (role) return role
      const state = ctx.milestoneState
      if (state === undefined) return missingMilestone(action)
      if (!stateIsOneOf(state, [MSTATE.Submitted, MSTATE.Attested])) {
        return deny(
          `You can only dispute a Submitted or Attested milestone, and this one is ` +
            `${STATE_LABEL[state]}. There is no submission here to contest.`,
        )
      }
      return ALLOW
    }

    // resolveDispute — arbiter; state Disputed.
    case 'resolveDispute': {
      const role = requireRole('arbiter', ctx.role, 'resolve a dispute')
      if (role) return role
      const state = ctx.milestoneState
      if (state === undefined) return missingMilestone(action)
      if (state !== MSTATE.Disputed) {
        return deny(
          `There is no dispute to resolve — this milestone is ${STATE_LABEL[state]}, not ` +
            'Disputed. The client has to open a dispute first.',
        )
      }
      return ALLOW
    }

    // reclaim — client; after deadline, state Pending or Submitted.
    //
    // State is checked before the clock so that an Attested milestone gets the reason that
    // actually matters: work proven in time survives the deadline and is never reclaimable.
    case 'reclaim': {
      const role = requireRole('client', ctx.role, 'reclaim this milestone')
      if (role) return role
      const state = ctx.milestoneState
      if (state === undefined) return missingMilestone(action)
      if (state === MSTATE.Attested) {
        return deny(
          'This milestone was attested, so the work was proven and the deadline no longer ' +
            'ends it. Approve it, or open a dispute if you believe the attestation is wrong.',
        )
      }
      if (!stateIsOneOf(state, [MSTATE.Pending, MSTATE.Submitted])) {
        return deny(
          `Reclaim returns the escrow for a Pending or Submitted milestone, and this one is ` +
            `${STATE_LABEL[state]}. Its funds have already been settled.`,
        )
      }
      if (ctx.now < ctx.deadline) {
        return deny(
          `The deadline is still ${formatDuration(ctx.deadline - ctx.now)} away, and the ` +
            'freelancer has until then to deliver. You can reclaim once it passes.',
        )
      }
      return ALLOW
    }

    // withdraw — anyone owed; owed > 0. Compared as bigint, never Number.
    case 'withdraw': {
      const owed = parseWei(ctx.owed)
      if (owed === null) {
        return deny(
          'MonEscrow could not read what this wallet is owed from the chain data it was given. ' +
            'Reload the job page to refresh it, then try again.',
        )
      }
      if (owed <= 0n) {
        return deny(
          'This wallet is owed nothing right now, so there is nothing to withdraw. ' +
            'Money lands here after a release, a reclaim or a resolved dispute.',
        )
      }
      return ALLOW
    }
  }
}

/**
 * Every action with its verdict, in table order.
 *
 * The caller renders the allowed ones as buttons and the blocked ones greyed with the reason
 * beside them. A greyed button that says why teaches the mechanism — "the challenge window has
 * 2 hours left" — while a hidden one teaches nothing.
 */
export function availableActions(ctx: ActionContext): ActionVerdict[] {
  return ALL_ACTIONS.map((action) => ({
    action,
    permission: permits(action, ctx),
    proposable: isProposable(action),
  }))
}
