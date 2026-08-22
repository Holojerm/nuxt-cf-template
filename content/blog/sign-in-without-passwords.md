---
title: 'Sign-in without passwords'
description: 'A magic link is the front door and OAuth sits underneath it. Why the account key is a verified email address, and what that costs to get right.'
date: '2026-08-05'
author: 'My Company Ltd'
---

There is no password field anywhere in this template, and there is no plan to add one. Not
because passwords are unfashionable, but because storing them is a liability you take on
permanently in exchange for a login form that people are worse at using than their own inbox.

What ships instead is a magic link as the primary path, with OAuth providers underneath it as
conveniences.

## Why the link is the front door and not the fallback

Most templates get this the other way round: three provider buttons at the top, and a small
"or sign in with email" underneath. That ordering encodes an assumption about who is signing
up, and for a consumer product the assumption is usually wrong.

A GitHub button in the primary position tells most visitors the product is not for them.
Google is broader but still asks someone to hand a third party a signal about what they are
buying, and a meaningful fraction of people will simply not. An email address is the one
credential every single visitor already has and already knows how to use.

So the email form leads. The providers are there for the people who prefer them, and the
[login page](/login) only renders a provider button when that provider is actually
configured — a fork that never sets up GitHub does not show a button that dead-ends in a
configuration error.

## The account key is a verified email address

This is the decision everything else hangs off. There is no row per provider. There is one
`users` row per address, and every sign-in path resolves to it.

Sign in with Google in the morning and click a magic link in the evening, and you are the
same account. That is what people expect, and it quietly avoids the duplicate-account support
load that provider-keyed identity creates.

It is only safe because of one rule, held everywhere: **every path that establishes a session
must state explicitly whether the address was verified**. A provider that hands back an
unverified address, or a code path that defaults the flag to true because it is convenient,
turns this design into an account-takeover primitive — claim an address you do not own at a
sloppy provider, and you inherit the account. So the flag is a required argument, never a
default, and adding a provider means deciding what that provider actually proved.

## What the link itself is

Thirty-two bytes from a cryptographic random source, base64url-encoded, valid for fifteen
minutes, single use. Only the SHA-256 hash reaches the database, so a leaked snapshot of the
table contains no usable links.

Fifteen minutes is short, and it is chosen rather than inherited. It is the shortest window
that survives the real journey: request it on a laptop, unlock a phone, wait for the push
notification, tap through a mail client. Shorter than that and the product reads as broken to
anyone who steps away from their desk. Longer and a live credential sits in an inbox that may
be shared, synced to three devices, or already compromised.

Single use is the part that needs a test rather than an intention. A link that still works
the second time is a link that works for whoever else has a copy of the email — a forwarded
message, a shared mailbox, a corporate scanner that follows URLs to check them. Replaying a
redeemed link has to lose, and the only way to know it does is a test that tries.

## Rate limiting an endpoint that sends mail

A sign-in endpoint that emails a stranger on request is an unusual thing to expose. Left
open, it is a free way to deliver mail to any address, with your domain on it, until your
sending reputation is gone.

Two limits sit on it: a per-IP limit across the whole authentication surface, and a per-address
limit on top. The second one is the one that matters, because the abuse that costs you is
hundreds of requests for one victim's address rather than one request from each of hundreds of
addresses.

Both fail open. A rate limiter that takes sign-in down when its own storage has a bad minute
has made the outage worse, not better — this is abuse control, not metering, and anything
you intend to bill on needs a stronger primitive than an eventually-consistent counter.

## What this costs you

Honesty about the trade: passwordless sign-in makes email deliverability a hard dependency. If
your mail does not arrive, nobody can log in — there is no second path for them to fall back
to. That means a verified sending domain, real DNS records, and paying attention when
deliverability degrades.

In exchange you never store a password, never build a reset flow, never handle a credential
stuffing incident, and never explain to anyone why their account was breached by a password
they reused somewhere else. On balance, for a product being built by a small team, that is not
a close call.
