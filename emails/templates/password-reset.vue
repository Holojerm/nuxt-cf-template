<!-- Sent by the credentials layer (layers/credentials) when someone asks to reset a
     password. Only ever mailed to an address that has an account. -->
<template>
  <EmailLayout heading="Reset your {{appName}} password">
    <EmailParagraph>
      Use this link to choose a new password. It works once and expires in
      <Raw>{{expiresMinutes}}</Raw> minutes.
    </EmailParagraph>
    <EmailButton href="{{url}}">Choose a new password</EmailButton>
    <template #footnote>
      Button not working? Paste this into your browser: <Raw>{{url}}</Raw>
      <br /><br />
      If you didn't ask for this, you can ignore this email — your password stays as it is until
      the link is used.
    </template>
  </EmailLayout>
</template>
