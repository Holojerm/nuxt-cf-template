<template>
  <EmailLayout heading="Welcome to {{appName}}">
    <EmailParagraph>Hi <Raw>{{name}}</Raw> — your account is ready.</EmailParagraph>
    <EmailParagraph>
      You're signed in already. If you ever get locked out, sign in again with the same provider
      and you'll land back on this account.
    </EmailParagraph>
    <EmailButton href="{{appUrl}}">Open the app</EmailButton>
    <template #footnote>
      You're receiving this because an account was created with this email address at
      <Raw>{{appName}}</Raw>.
    </template>
  </EmailLayout>
</template>
