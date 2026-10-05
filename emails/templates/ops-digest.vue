<!-- Data: summary, generated, logsUrl?, kinds[]. Each kind carries exactly one of
     bad/warn/good (its tone), a label, the raw kind id, the total count, up to five
     rows, and `more` — how many rows were left out, or 0.

     The tone is three copies of the bar and the badge, selected at runtime, because
     a color has to be inlined at build time and the kind is only known at runtime. -->
<template>
  <EmailLayout wide title="{{appName}} alert" kicker="{{appName}} alert" heading="{{summary}}">
    <Raw>{{#kinds}}</Raw>
    <table role="presentation" class="mb-5 w-full">
      <tr>
        <Raw>{{#bad}}</Raw><td class="w-[3px] bg-bad"></td><Raw>{{/bad}}</Raw>
        <Raw>{{#warn}}</Raw><td class="w-[3px] bg-warn"></td><Raw>{{/warn}}</Raw>
        <Raw>{{#good}}</Raw><td class="w-[3px] bg-good"></td><Raw>{{/good}}</Raw>
        <td class="pl-3">
          <p class="m-0 mb-1 text-[15px] font-semibold text-ink">
            <Raw>{{label}}</Raw>
            <Raw>{{#bad}}</Raw><span class="ml-1.5 rounded-full bg-bad px-2 py-px text-xs font-semibold text-on-accent"><Raw>{{count}}</Raw></span><Raw>{{/bad}}</Raw>
            <Raw>{{#warn}}</Raw><span class="ml-1.5 rounded-full bg-warn px-2 py-px text-xs font-semibold text-on-accent"><Raw>{{count}}</Raw></span><Raw>{{/warn}}</Raw>
            <Raw>{{#good}}</Raw><span class="ml-1.5 rounded-full bg-good px-2 py-px text-xs font-semibold text-on-accent"><Raw>{{count}}</Raw></span><Raw>{{/good}}</Raw>
            <span class="ml-1.5 font-mono text-xs font-normal text-muted"><Raw>{{kind}}</Raw></span>
          </p>
          <Raw>{{#rows}}</Raw>
          <div class="border-0 border-t border-solid border-rule py-2">
            <div class="font-mono text-xs text-muted">
              <Raw>{{time}}</Raw><Raw>{{#path}}</Raw> &middot;
              <Raw>{{#pathUrl}}</Raw><a href="{{pathUrl}}" class="text-copy"><Raw>{{path}}</Raw></a><Raw>{{/pathUrl}}</Raw>
              <Raw>{{^pathUrl}}</Raw><Raw>{{path}}</Raw><Raw>{{/pathUrl}}</Raw>
              <Raw>{{/path}}</Raw>
            </div>
            <Raw>{{#detail}}</Raw>
            <div class="text-sm leading-normal text-copy [word-break:break-word]"><Raw>{{detail}}</Raw></div>
            <Raw>{{/detail}}</Raw>
          </div>
          <Raw>{{/rows}}</Raw>
          <Raw>{{#more}}</Raw>
          <div class="pt-2 text-[13px] text-muted">…and <Raw>{{more}}</Raw> more</div>
          <Raw>{{/more}}</Raw>
        </td>
      </tr>
    </table>
    <Raw>{{/kinds}}</Raw>
    <table role="presentation" class="mb-2">
      <tr>
        <Raw>{{#logsUrl}}</Raw>
        <td class="pr-2"><EmailButton href="{{logsUrl}}" tone="ink" compact>Open logs</EmailButton></td>
        <Raw>{{/logsUrl}}</Raw>
        <Raw>{{#appUrl}}</Raw>
        <td><EmailButton href="{{appUrl}}" tone="ink" compact>Open <Raw>{{appName}}</Raw></EmailButton></td>
        <Raw>{{/appUrl}}</Raw>
      </tr>
    </table>
    <template #footnote>
      Runbook: README.md › Ops alerting. Sent by the ops:alert cron when events are waiting; quiet
      ticks send nothing. Generated <Raw>{{generated}}</Raw>.
    </template>
  </EmailLayout>
</template>
