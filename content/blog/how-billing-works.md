---
title: 'How the billing model works: subscriptions and one-time passes'
description: 'Two products share one entitlements table, told apart by the Paddle reference prefix. Here is how access is granted, stacked, and revoked.'
date: '2026-06-18'
author: 'My Company Ltd'
---

Most billing bugs are not arithmetic. They are a question nobody wrote down: *at this
instant, is this person allowed in?* Answer it in three places and you will eventually
answer it three different ways.

This template answers it in one place — a row in the `entitlements` table — and everything
else either writes that row or reads it.

## Two products, one table

There are two things you can buy, and the [pricing page](/pricing) lists both. A subscription
renews until someone stops it. A 30-day pass does not renew at all; you buy thirty days and
they run out. They are priced
differently, they behave differently on refund, and a customer support answer that confuses
them is a customer support answer that is wrong.

They still share a table, because what they produce is identical: a period of access with an
end date. What tells them apart is the Paddle reference stored alongside the row. A
subscription arrives as `sub_…` and a one-time purchase as `txn_…`, and that prefix is the
only signal needed to pick the right lifecycle:

- A `sub_…` row follows Paddle's status. Paddle says `active`, the row says active. Paddle
  says `canceled`, access ends at the period boundary that was already paid for.
- A `txn_…` row has no lifecycle. No event will ever fire for it again. It grants access
  while its end date is in the future and nothing at all after that.

That difference has a consequence people meet on their second purchase: **passes stack**. Buy
a pass with eleven days left on the previous one and you get forty-one days, not thirty. The
alternative — resetting the clock — silently takes money for time it also deletes, and the
person who notices is the person who bought twice.

## Access is checked on the server, always

The client knows whether you are subscribed because it asked. That is a fine thing to base a
button's label on, and a catastrophic thing to base access on.

Every paid API route calls `requireSubscription(event)` itself. It throws `401` when there is
no session and `402` when there is a session with nothing behind it — two different problems
that deserve two different responses, since "sign in" and "buy something" are not the same
instruction. The route middleware that redirects a signed-out visitor to the login page is
presentation. It runs in the browser. It is not a security boundary and the code says so.

If you add a paid endpoint and forget that call, nothing fails. The endpoint works. It works
for everyone, forever, including the people who cancelled. This is the single easiest mistake
to make in a billing integration, which is why the gate is one function call with a name that
says what it does.

## Refunds, chargebacks, and the awkward middle

A refund is not a cancellation. A cancellation is someone leaving politely at the end of a
period they paid for; a refund is that period being unwound. The webhook handler treats them
as different events because customers do, and because a refunded month that still grants
access is a bug you find in your revenue numbers rather than in your logs.

`past_due` is the awkward middle: the card failed, Paddle will retry, and the person has not
done anything wrong. The template treats it as **not** granting access, and pairs that with a
banner and one email — the payment-failed email is the single most valuable transactional
message a subscription business sends, and it only works if you have not already trained
people to filter your mail by sending one for every trivial subscription update.

## Redeliveries are expected, not exceptional

Payment providers retry. A webhook that ran fine can arrive again ten minutes later because
the acknowledgement was lost, and it will arrive again at the worst possible moment. Every
handler here is idempotent: processing the same event twice produces the same row, not two
rows or double the days.

That property is covered by tests rather than by intention, because it is invisible until it
is expensive. The same is true of the whole entitlement layer — the refund path, the stacking
arithmetic, the ref-prefix split. None of it announces itself when it breaks. It just quietly
lets the wrong people in, or keeps the right ones out.
