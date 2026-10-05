<!-- The one email that is load-bearing, so it stays short: one paragraph, one button,
     and the URL spelled out for gateways that rewrite anchors. It carries no name —
     it is sent before we know whether the address has an account at all. -->
<template>
  <EmailLayout heading="Sign in to {{appName}}">
    <EmailParagraph>
      This link works once and expires in <Raw>{{expiresMinutes}}</Raw> minutes.
    </EmailParagraph>
    <EmailButton href="{{url}}">Sign in</EmailButton>
    <template #footnote>
      Button not working? Paste this into your browser: <Raw>{{url}}</Raw>
      <br /><br />
      If you didn't ask to sign in, you can ignore this email — nothing happens until the link is
      opened, and no account is created by this message.
    </template>
  </EmailLayout>
</template>
