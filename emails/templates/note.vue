<!-- The one email whose copy is data: lifecycle steps (server/utils/lifecycle-sequence.ts)
     and announcements (content/announcements/). `paragraphs` is a list of strings and
     `button` is absent or { label, url }. Every value is escaped by renderEmail(). -->
<template>
  <EmailLayout heading="{{heading}}">
    <Raw>{{#paragraphs}}</Raw>
    <EmailParagraph><Raw>{{.}}</Raw></EmailParagraph>
    <Raw>{{/paragraphs}}</Raw>
    <Raw>{{#button}}</Raw>
    <EmailButton href="{{url}}"><Raw>{{label}}</Raw></EmailButton>
    <Raw>{{/button}}</Raw>
    <template #footnote><Raw>{{footnote}}</Raw></template>
  </EmailLayout>
</template>
