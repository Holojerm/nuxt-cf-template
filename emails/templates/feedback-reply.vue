<!-- `reply` is typed by an admin; `quoted` is what a stranger wrote into the public
     feedback widget, already truncated by the caller. Both are untrusted as far as
     this file is concerned — they only ever appear as double-brace tags, which
     Mustache escapes. -->
<template>
  <EmailLayout heading="Re: your feedback">
    <EmailParagraph><Raw>{{reply}}</Raw></EmailParagraph>
    <EmailParagraph>—</EmailParagraph>
    <EmailParagraph>You wrote: "<Raw>{{quoted}}</Raw>"</EmailParagraph>
    <template #footnote>
      You're receiving this because you sent feedback through <Raw>{{appName}}</Raw>. Replying to
      this email reaches a person.
    </template>
  </EmailLayout>
</template>
