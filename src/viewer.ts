// A second client watching the document: prints the text as edits arrive, and
// any pause in them. Started by `bun run repro --viewer`: bun src/viewer.ts <document> <endpoint>
import { createClient } from 'rivetkit/client'
import type { Registry } from './registry.ts'

const [doc, endpoint] = process.argv.slice(2)
if (!doc || !endpoint) {
  throw new Error('usage: bun src/viewer.ts <document> <endpoint>')
}

const conn = createClient<Registry>(endpoint).textFile.getOrCreate([doc]).connect()
let text = ''
let lastAt = 0
conn.on('edit', (edit) => {
  const now = performance.now()
  if (lastAt && now - lastAt > 200) {
    console.log(`[viewer] no edits for ${Math.round(now - lastAt)} ms, then edit ${edit.seq}`)
  }
  lastAt = now
  text = text.slice(0, edit.pos) + edit.text + text.slice(edit.pos)
  if (edit.seq % 100 === 0) {
    console.log(`[viewer] v${edit.seq}: …${JSON.stringify(text.slice(-50))}`)
  }
})
await conn.ready
;({ text } = await conn.read())
console.log(`[viewer] watching ${doc}`)
