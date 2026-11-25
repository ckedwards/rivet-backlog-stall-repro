// Starts the actors and a local Rivet Engine (as RivetKit does in development),
// then types into a new document one keystroke at a time, each one awaited:
// one SQLite commit per keystroke. Prints the latencies and any slow keystroke.
//
//   bun run repro              type 1,300 characters into a fresh document
//   bun run repro --viewer     and watch it from a second client
//   KEYSTROKES=2000 bun run repro
//   KEYS_PER_SECOND=60 bun run repro   a typist's pace instead of back to back
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createClient } from 'rivetkit/client'
import { registry } from './registry.ts'

const KEYSTROKES = Number(process.env.KEYSTROKES ?? 1300)
const KEYS_PER_SECOND = Number(process.env.KEYS_PER_SECOND ?? 0) // 0: back to back
const SLOW_MS = 100
const SENTENCE = 'The quick brown fox jumps over the lazy dog while we type, one key at a time. '

registry.config.noWelcome = true
await registry.startAndWait()
const endpoint = registry.parseConfig().endpoint!
// a new document, so a new actor and a new SQLite database, every run
const doc = `doc-${crypto.randomUUID().slice(0, 8)}`
const conn = createClient<typeof registry>(endpoint).textFile.getOrCreate([doc]).connect()
await conn.read() // makes the actor (and runs its migration) before timing starts
console.log(`engine ${endpoint}, document ${doc}, typing ${KEYSTROKES} characters`)

const viewer = process.argv.includes('--viewer') ? await startViewer() : null

const latencies: number[] = []
const slow: string[] = []
const started = performance.now()
for (let i = 0; i < KEYSTROKES; i++) {
  const at = performance.now()
  await conn.insert({ client: 'typist', pos: i, text: SENTENCE[i % SENTENCE.length]! })
  const ms = performance.now() - at
  latencies.push(ms)
  if (ms > SLOW_MS) {
    const line = `slow keystroke #${i + 1}: ${Math.round(ms)} ms, started ${new Date(Date.now() - ms).toISOString()}`
    slow.push(line)
    console.log(line)
  }
  if (KEYS_PER_SECOND > 0) {
    await Bun.sleep(Math.max(0, 1000 / KEYS_PER_SECOND - ms))
  }
}
const total = performance.now() - started

const sorted = [...latencies].sort((a, b) => a - b)
const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!.toFixed(1)
console.log(
  `\n${KEYSTROKES} keystrokes in ${(total / 1000).toFixed(2)} s (${Math.round(KEYSTROKES / (total / 1000))}/s): ` +
    `p50 ${pct(50)} ms, p95 ${pct(95)} ms, max ${sorted.at(-1)!.toFixed(1)} ms`,
)
console.log(`${slow.length} keystroke(s) over ${SLOW_MS} ms`)
const { version, text } = await conn.read()
console.log(`document at version ${version}, ${text.length} characters`)

// the engine's log lines about it (RUST_LOG=depot_client=debug to see them), without the long key
const logs = join(process.env.RIVETKIT_STORAGE_PATH ?? '.data', '.rivetkit/var/logs/rivet-engine')
for (const file of readdirSync(logs).filter((f) => f.endsWith('.log'))) {
  for (const line of readFileSync(join(logs, file), 'utf8').split('\n')) {
    if (/refusing a filesystem write|dropped expired overlay notes/.test(line)) {
      console.log(`[engine] ${line.replace(/ key="(?:[^"\\]|\\.)*"/, ' key=…')}`)
    }
  }
}
console.log(`(engine log: ${logs})`)

await Bun.sleep(300) // let the viewer get the last edits
viewer?.kill()
await conn.dispose()
await registry.shutdown()
process.exit(0)

/** The viewer, as a process of its own, once it's watching the document. */
async function startViewer() {
  const child = Bun.spawn(['bun', join(import.meta.dir, 'viewer.ts'), doc, endpoint], { stdout: 'pipe', stderr: 'inherit' })
  const reader = child.stdout.getReader()
  const { promise: ready, resolve: watching } = Promise.withResolvers<void>()
  void (async () => {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        return
      }
      const chunk = new TextDecoder().decode(value)
      process.stdout.write(chunk)
      if (chunk.includes('[viewer] watching')) {
        watching()
      }
    }
  })()
  await ready
  return child
}
