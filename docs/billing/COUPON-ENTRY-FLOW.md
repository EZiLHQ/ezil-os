# Coupon entry and normal Billing

Both `/?coupon=<registered partnerId>` and existing `/sponsor/<opaque token>` links resolve only the existing signed campaign registry. The root uses an internal redirect to the coupon route because a page component cannot mint the route-handler OAuth cookies; no landing document or extra Continue action is shown.

| Arrival | Result |
| --- | --- |
| Anonymous, valid coupon or invitation | Normal Auth0 authorize flow; verified callback opens `/os?settings=billing` as a document. |
| Server-verified existing OS account with protected Auth0 link | First attribution is materialized idempotently, then Billing opens with its server offer status. The OS account/session is retained. |
| Existing account without trusted Auth0 link | Billing displays `coupon_entry=identity_required`; no automatic account switch or attribution. |
| Unknown, duplicate, mixed, expired or unavailable selection | Normal sign-in if needed, then fixed Billing `coupon_entry=unavailable`; input is not reflected. |
| Invalid/oversized legacy Continue POST | Refused before session, OAuth and sponsor SQL handling; safe Billing error navigation. Foreign/missing/null Origin or invalid declared size remains403. |

GET handoff requires a document navigation (native fetch metadata, or `Accept: text/html` for older headerless browsers); images, iframes and fetches are refused before session, SQL or OAuth access. This prevents untrusted same-site previews from selecting an attribution as a subresource.

The shell consumes and clears the two allowlisted `coupon_entry` display hints. A caller can imitate a display hint, but it cannot create attribution, eligibility or a trial. `summary.trialOffer` is authoritative; valid sponsor attribution wins over the public offer, including when the public gate is off. Prior Standard trial/paid-account eligibility remains unchanged and must be shown clearly in Billing. The entry layer never writes trial claims, grants or payments.

For login retry, the secure origin-bound ten-minute handoff holds a signed campaign/config reference. It contains no reusable invitation token or verified provider identity. Normal login reseals this selection into fresh state/nonce/PKCE only for the fixed Billing destination; callback success consumes the handoff, and OAuth transaction consumption remains unchanged. Silent identity refresh remains identity-only; an interactive fallback may recover the pending valid selection. Every use revalidates the signed live campaign/config. Failure or expiry requires a current valid invitation rather than trusting query campaign IDs.

Checks cover both link formats, existing-session account preservation, absence of user-metadata authority, public-off signed context, HMAC corruption/origin/expiry/revocation, fresh OAuth state and silent fallback, duplicate/mixed inputs, actual streamed body bounds and the owned forwarded-origin guard. Callback and bridge regressions continue to require verified email and OTP before attribution. No DB schema, environment, registry, provider or deployed runtime is changed by this source work.
