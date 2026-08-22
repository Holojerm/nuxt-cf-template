---
title: 'Why this template ships single-user'
description: 'There are no teams, no organisations, and no seats. That is a decision about what most products actually need, not an omission to fix later.'
date: '2026-07-09'
updated: '2026-08-05'
author: 'My Company Ltd'
---

Open the schema and you will find a `users` table and an `entitlements` table. You will not
find `organizations`, `memberships`, `roles`, `invitations`, or `seats`. That is deliberate,
and it is the decision most likely to be questioned by someone evaluating this template
against a checklist.

So here is the reasoning, in full, including where it stops being right.

## Multi-tenancy is not a feature you add once

The tempting version of this argument is "you can add teams later". That is true in the sense
that any code can be written later. It is misleading in the sense that matters, because
multi-tenancy is not a module — it is a property of every query you have already written.

Adding organisations means every read grows a tenant predicate, every write grows an
authorisation check against membership rather than ownership, billing moves from a person to
a group, and the session has to carry which tenant you are currently acting as. A template
that ships all of that has made the choice for you, in every file, before you know whether
your product needs it.

The reverse is not symmetrical. Removing an unused organisation layer from a codebase is not
a deletion; it is an untangling, and it is the kind of work that leaves a `default_org_id`
behind for years.

## Most products bill a person

Look at what the entitlement layer actually models: a person, a period of access, a payment
reference. For a consumer product, a solo tool, a paid API, or anything sold to an individual
who expenses it, that is the whole domain. Adding a group above it would be an empty box in
every row.

Identity here is the [verified email address](/blog/sign-in-without-passwords), not a
provider account. Sign in with Google
today and with a magic link tomorrow, and you land on the same account, because the address
is the same and both paths asserted that it was verified. That is the right model for one
person with several sign-in habits, and it is also exactly the model that gets subtle once a
group is involved — at which point "who owns this row" stops having an obvious answer, and
the answer needs a table rather than a column.

## What you actually get instead

Single-user is not the same as unstructured. The template ships the parts of an account
system that a single user genuinely needs and that people routinely leave out:

- A `role` column with an admin console behind it, so *you* can look at the system without a
  second product.
- An audit log, append-only, so privileged actions have a record.
- Account deletion and export, because the person whose data it is gets to leave with it.
- Notification preferences and one-click unsubscribe, which are a legal requirement in more
  places than people expect.

Those are the things a "simple" template usually omits and a real product cannot. Teams are
the thing a template usually includes and most products never switch on.

## When to add the layer

Add organisations when you have a customer who has told you they need them, and specifically
when at least one of these is true:

- Two people must see the same data without sharing a login.
- Someone other than the user pays, and the payer needs to control who has access.
- Access has to survive an individual leaving.

Until one of those is true, a "team" is a table with one row per user and a foreign key that
does nothing.

When it is time, the seams are marked. Ownership lives on `user_id` columns, entitlement
lookups go through one function, and the session payload is small and typed. The work is
real, but it is the work your product actually needs by then — not the work a template
guessed at while you were still deciding what to build.
