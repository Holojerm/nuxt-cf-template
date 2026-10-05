<!-- `isPass` picks the pass wording; anything else reads as a subscription. `ends` is
     a preformatted date or absent, so the sentence simply loses its clause. -->
<template>
  <EmailLayout
    heading="{{#isPass}}Your pass is active{{/isPass}}{{^isPass}}Your subscription is active{{/isPass}}"
  >
    <EmailParagraph>
      Thanks, <Raw>{{name}}</Raw>. Your access is live — nothing else to do.
    </EmailParagraph>
    <EmailParagraph>
      <Raw>{{#isPass}}</Raw>This is a one-time pass<Raw>{{#ends}}</Raw>, good through
      <Raw>{{ends}}</Raw><Raw>{{/ends}}</Raw>. It won't renew, and you won't be charged
      again.<Raw>{{/isPass}}</Raw>
      <Raw>{{^isPass}}</Raw>Your subscription renews automatically<Raw>{{#ends}}</Raw>, next on
      <Raw>{{ends}}</Raw><Raw>{{/ends}}</Raw>. You can cancel any time from your account page — no
      email required.<Raw>{{/isPass}}</Raw>
    </EmailParagraph>
    <EmailParagraph>
      Paddle handles the payment, so your receipt and invoice come from them in a separate email.
    </EmailParagraph>
    <EmailButton href="{{appUrl}}/account">Go to your account</EmailButton>
    <template #footnote>Questions about the charge? Reply to this email.</template>
  </EmailLayout>
</template>
