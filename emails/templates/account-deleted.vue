<!-- No button on purpose: the account this is about no longer exists, and a "Go to
     your account" under a deletion notice would be a broken promise in the most
     alarming possible place. -->
<template>
  <EmailLayout heading="Your account has been deleted">
    <EmailParagraph>
      Hi <Raw>{{name}}</Raw> — this confirms your <Raw>{{appName}}</Raw> account and everything in
      it has been deleted, as you asked.
    </EmailParagraph>
    <EmailParagraph>
      Billing records are kept for as long as tax law requires — that's the only thing this doesn't
      touch, and it's described in our privacy policy.
    </EmailParagraph>
    <EmailParagraph>If you didn't request this, reply to this email right away.</EmailParagraph>
  </EmailLayout>
</template>
