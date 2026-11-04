// The merge gate — `bun run ci` (Workers Builds' build command) and `bun run ci:fast`.
//
// Runs the gates concurrently instead of as one `&&` chain, and runs every gate even after
// one fails: an agent that sees all failures at once fixes them in one pass instead of one
// rerun per failure. Only a failing gate's output is printed.
//
// The phases run in order because `nuxt typecheck` and `nuxt build` both regenerate `.nuxt/`
// and `node_modules/@nuxthub`. They must not overlap each other, and they must not overlap
// `forkless:check`, whose isolation guard fails when that module changes under it. Vitest
// runs in workerd and touches neither, so it runs alongside every phase.
//
//   bun run ci              # every gate, then the build
//   bun run ci:fast         # iterate: cheap gates + typecheck + tests touched since origin/main
//   CI_SERIAL=1 bun run ci  # one gate at a time, if a small machine runs out of memory

const fast = process.argv.includes('--fast')
const serial = process.env.CI_SERIAL === '1'

type Gate = { name: string; cmd: string[] }
const run = (script: string, ...args: string[]): Gate => ({
  name: [script, ...args].join(' '),
  cmd: ['bun', 'run', script, ...args],
})

const cheap = [
  'lint',
  'format:check',
  'design:check',
  'brand:check',
  'email:check',
  'mirror:check',
  'seo:check',
  'fleet:check',
  'crons:check',
  'methods:check',
  'layers:check',
].map((s) => run(s))

const background = fast ? run('test', '--changed', 'origin/main', '--passWithNoTests') : run('test')
const phases: Gate[][] = fast
  ? [[...cheap, run('typecheck')]]
  : [[...cheap, run('forkless:check')], [run('typecheck')], [run('build')]]

type Result = { gate: Gate; ok: boolean; seconds: number; output: string }

async function exec(gate: Gate): Promise<Result> {
  const start = performance.now()
  const proc = Bun.spawn(gate.cmd, { stdout: 'pipe', stderr: 'pipe', env: process.env })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  const seconds = (performance.now() - start) / 1000
  const result = { gate, ok: code === 0, seconds, output: out + err }
  console.info(`${result.ok ? '✓' : '✗'} ${gate.name} ${seconds.toFixed(1)}s`)
  return result
}

async function runPhase(gates: Gate[]): Promise<Result[]> {
  if (!serial) return Promise.all(gates.map(exec))
  const results: Result[] = []
  for (const gate of gates) results.push(await exec(gate))
  return results
}

const TAIL = 80
const started = performance.now()
const results: Result[] = []
const tests = serial ? null : exec(background)
for (const phase of phases) results.push(...(await runPhase(phase)))
results.push(await (tests ?? exec(background)))

const failed = results.filter((r) => !r.ok)
for (const r of failed) {
  const lines = r.output.trimEnd().split('\n')
  console.info(
    `\n── ✗ ${r.gate.name} (last ${Math.min(TAIL, lines.length)} of ${lines.length} lines) ──`,
  )
  console.info(lines.slice(-TAIL).join('\n'))
}
const total = ((performance.now() - started) / 1000).toFixed(1)
console.info(
  failed.length
    ? `\n${failed.length} of ${results.length} gates failed in ${total}s: ${failed.map((r) => r.gate.name).join(', ')}`
    : `\nAll ${results.length} gates passed in ${total}s`,
)
process.exit(failed.length ? 1 : 0)
