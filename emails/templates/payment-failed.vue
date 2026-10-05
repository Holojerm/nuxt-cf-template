<template>
  <EmailLayout heading="Your payment did not go through">
    <EmailParagraph>
      Hi <Raw>{{name}}</Raw> — the last charge for your <Raw>{{appName}}</Raw> subscription was
      declined.
    </EmailParagraph>
    <EmailParagraph>
      Paddle will retry it over the next few days. If it keeps failing, your access will stop.
      Updating your card now avoids that entirely.
    </EmailParagraph>
    <EmailButton href="{{appUrl}}/account">Update payment method</EmailButton>
    <template #footnote>
      If you meant to cancel, you can ignore this — access ends on its own.
    </template>
  </EmailLayout>
</template>
