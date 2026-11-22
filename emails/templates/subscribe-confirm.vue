<template>
  <EmailLayout heading="Confirm your email address">
    <EmailParagraph>
      Someone asked for product updates from <Raw>{{appName}}</Raw> to be sent to this address. If
      that was you, confirm below.
    </EmailParagraph>
    <EmailParagraph>
      You'll get an occasional email when something new ships, and every one has a link that
      removes your address.
    </EmailParagraph>
    <EmailButton href="{{url}}">Confirm and send me updates</EmailButton>
    <EmailParagraph>
      The link works for <Raw>{{days}}</Raw> days. If the button doesn't work, copy this into your
      browser: <Raw>{{url}}</Raw>
    </EmailParagraph>
    <template #footnote>
      If this wasn't you, ignore this email. Nothing else will be sent to this address, and it is
      deleted after <Raw>{{days}}</Raw> days.
    </template>
  </EmailLayout>
</template>
