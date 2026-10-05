<!-- One boolean per reason, exactly one true. The refund and chargeback wording is
     deliberate: never argumentative. `compRevoked` says nothing about a payment
     (none was made) and does not say who removed it — the customer did nothing
     wrong, and an accusatory sentence about free access trades goodwill for
     precision. -->
<template>
  <EmailLayout heading="Your access has ended">
    <EmailParagraph>
      Hi <Raw>{{name}}</Raw> —
      <Raw>{{#canceled}}</Raw>Your subscription has been canceled and your access has
      ended.<Raw>{{/canceled}}</Raw>
      <Raw>{{#refunded}}</Raw>Your payment was refunded, so the access it paid for has
      ended.<Raw>{{/refunded}}</Raw>
      <Raw>{{#chargeback}}</Raw>A chargeback was filed on this payment, so access has been
      suspended while it's resolved.<Raw>{{/chargeback}}</Raw>
      <Raw>{{#compRevoked}}</Raw>The complimentary access on your account has
      ended.<Raw>{{/compRevoked}}</Raw>
    </EmailParagraph>
    <EmailParagraph>
      Your account and data are still here. Subscribing again turns everything back on where you
      left it.
    </EmailParagraph>
    <EmailButton href="{{appUrl}}/pricing">See plans</EmailButton>
    <template #footnote>
      <Raw>{{#chargeback}}</Raw>If you didn't file this chargeback, reply to this email and we'll
      sort it out.<Raw>{{/chargeback}}</Raw>
      <Raw>{{^chargeback}}</Raw>If this was a mistake, reply to this email and we'll
      help.<Raw>{{/chargeback}}</Raw>
    </template>
  </EmailLayout>
</template>
