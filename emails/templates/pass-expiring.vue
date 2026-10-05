<template>
  <EmailLayout heading="Your access runs until {{date}}">
    <EmailParagraph>
      Hi <Raw>{{name}}</Raw> — your <Raw>{{appName}}</Raw> pass ends on <Raw>{{date}}</Raw>. It
      won't renew, and you won't be charged.
    </EmailParagraph>
    <EmailParagraph>
      If you want to keep going, you can buy another pass or turn on monthly renewal from your
      account. If not, there's nothing to do — your account and work stay here either way.
    </EmailParagraph>
    <EmailButton href="{{appUrl}}/account">Manage access</EmailButton>
    <template #footnote>
      You're receiving this because your pass is ending. It's sent once per pass.
    </template>
  </EmailLayout>
</template>
