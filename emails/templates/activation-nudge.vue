<template>
  <EmailLayout heading="Pick up where you left off">
    <EmailParagraph>
      Hi <Raw>{{name}}</Raw> — you created a <Raw>{{appName}}</Raw> account but haven't finished
      getting set up.
    </EmailParagraph>
    <EmailParagraph>
      It takes a couple of minutes, and the checklist on your dashboard shows exactly what's left.
    </EmailParagraph>
    <EmailParagraph>
      If something got in the way, reply to this email — a person reads it.
    </EmailParagraph>
    <EmailButton href="{{appUrl}}/dashboard">Finish setting up</EmailButton>
    <template #footnote>This is the only reminder we send about setup.</template>
  </EmailLayout>
</template>
