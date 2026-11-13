# Slack cross-connect: feasibility

Question: could BE Teammate serve Slack as well as Teams, so Slack and Teams people talk to the same bots
with the same memory, tools and audit — and is that a product that exists in the market?

## Short answer

Technically yes, and the codebase is unusually well placed for it: everything that makes BE Teammate
interesting — engine, gate, connections, memory, routines, audit — is already platform-neutral. Teams is
one adapter. The work is real but bounded: **about 5–7 weeks for company bots on Slack**, and a further
**2–3 weeks for personal assistants**, whose Microsoft Graph access needs a per-user OAuth flow because
Slack has no Teams SSO.

Building a *human* relay (mirroring a Slack channel into a Teams channel) is a different product and not
worth building: it is a commodity with several mature vendors, and full fidelity is a swamp.

## What is already portable

| Layer | Teams coupling today | Portability |
| --- | --- | --- |
| `engine/` (runner, gate, tools, providers) | none | as is |
| `connections/`, `knowledge/`, `memory/`, `learnings/`, `routines/`, `audit/` | none | as is |
| `teams/handlers.ts` (routing, bursts, confirmations, overheard) | Adaptive Cards, Teams mention model | logic reusable, the card renderer is not |
| `teams/app.ts` (Bot Framework) | the whole adapter | replace with a Slack adapter |
| `teams/proactive.ts` | stores a Teams conversation reference for outbound | Slack needs its own reference (channel id + thread ts) |
| `chats` / `people` | keyed by Teams conversation id and Entra object id | needs a platform prefix and an identity mapping |

The seam is already the right shape: `handleMessage(deps, IncomingMessage, TeamsIo)` — a message in, a
small IO interface out (`send`, `sendCard`, `typing`, `graphToken`). A Slack adapter implements the same
two objects.

## The hard parts, in order

1. **Identity.** A chat in `chats` is a Teams conversation; a person in `people` is an Entra object. In
   Slack, neither carries an Entra id. Match on **email** (works when Slack and M365 are the same people
   and domain) and let an admin map the rest. Unmapped users get “ask an admin to link you”.
2. **Personal assistants.** They act *as the person* in Microsoft 365, using a delegated token that Teams
   SSO hands us silently. Slack has no equivalent, so each owner would complete a Microsoft sign-in once
   (authorization code + PKCE, refresh token stored encrypted, revocable). Doable — it is the same flow we
   just repaired for Teams, only user-initiated in a browser — but it is new auth surface and a policy
   decision (who may link, what happens on revocation).
3. **Cards.** Confirmations are Adaptive Cards. Slack needs Block Kit buttons plus an interaction endpoint.
   Both platforms already accept a typed **yes / no**, so a text-only v1 works without any card work.
4. **Threads and files.** Slack threads (`thread_ts`), file uploads (three-step external upload), and 3-second
   event acks differ from Teams. Mechanical, but where most of the adapter time goes.
5. **Distribution.** Slack apps are installed per workspace (OAuth), distributed publicly or as an unlisted
   internal app. That is a second per-client onboarding step next to the Teams package.

## Effort

| Phase | Scope | Estimate |
| --- | --- | --- |
| Spike | Socket Mode, one channel, text replies, typed confirmations, email matching | 2–3 days |
| v1 | Company bots: events, threads, Block Kit confirmations, attachments, per-channel binding, admin mapping screen, install flow | 5–7 weeks |
| v2 | Personal assistants: OAuth link, encrypted refresh tokens, revocation, Slack-side privacy rules | +2–3 weeks |
| Never | Human Slack↔Teams channel mirroring | — |

Running cost is a second platform to support: two event models, two card formats, two rate-limit regimes.

## Is it out there?

Yes — in two separate categories, neither of which is quite this product.

**Channel bridges (human ↔ human).** Mio, SlackBridge, Conclude Bridge, TetherChat, and the open-source
Matterbridge. Mature, sold per organisation, priced per user. They solve “our Teams people and their Slack
people need one channel”, not “the same bot with the same tools on both”.

**One agent on both platforms (bot ↔ both).** This exists and is growing: Freshservice's Servicebot,
Moveworks, Viktor, Runbear, Lyzr, and CopilotKit's MIT-licensed Channels SDK (Aug 2026) which renders one
agent natively in Slack and Teams. Microsoft's own Copilot Studio is Teams-first and reaches Slack only
through a relay you build and host. The consistent finding across vendor docs is that “works in Slack and
Teams” usually means two integrations with different capability sets, not one agent with one memory.

**What is rare** is the combination BE Teammate has: self-hosted per tenant, per-connection permissions with
a confirmation gate, shared memory and audit, and *the same bots* on both platforms. That is a defensible
position, and “do you work in Slack?” is a standard RFP question for anything sold as a teammate.

## Risks

- **Platform direction.** Slack is building its own agent/MCP surface and Microsoft keeps Teams first; a
  neutral layer is a hedge, but both platforms can commoditise the adapter.
- **Security review.** A second chat platform means a second data path; each client will ask where Slack
  content is stored and who can read it.
- **Identity drift.** Two directories that disagree (contractors in Slack only, shared mailboxes in M365)
  turn into support tickets unless the admin mapping screen is good.

## Recommendation

1. **Build the adapter, not a bridge.** Slack users talk to the same bots; do not mirror human channels.
2. **Spike first (3 days).** Socket Mode, one channel, text + typed confirmations, email matching. It proves
   the seam and gives a demo.
3. **Sell company bots on Slack first.** They need no per-user Microsoft token, so v1 has no new auth surface.
4. **Personal assistants second**, with an explicit “link your Microsoft account” step.
5. If a client wants Slack↔Teams human interop, integrate Mio or Conclude alongside; do not build it.
