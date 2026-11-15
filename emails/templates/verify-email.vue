<!-- Sent by the credentials layer (layers/credentials) to finish a sign-up. Carries no
     name: it goes out before the address has an account, and the same message goes to an
     address that already has one. -->
<template>
  <EmailLayout heading="Finish creating your {{appName}} account">
    <EmailParagraph>
      Open this link to choose your password and finish creating your account. It works once and
      expires in <Raw>{{expiresMinutes}}</Raw> minutes.
    </EmailParagraph>
    <EmailButton href="{{url}}">Choose your password</EmailButton>
    <template #footnote>
      Button not working? Paste this into your browser: <Raw>{{url}}</Raw>
      <br /><br />
      If you didn't sign up, you can ignore this email — no account is created until the link is
      opened.
    </template>
  </EmailLayout>
</template>
