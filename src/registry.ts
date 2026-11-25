// A collaborative text file: one actor per document, every keystroke an edit
// row in RivetKit's SQLite, committed in its own transaction.
import { actor, event, setup } from 'rivetkit'
import { db } from 'rivetkit/db'

export type Edit = { seq: number; client: string; pos: number; text: string }

export const textFile = actor({
  db: db({
    onMigrate: async (database) => {
      await database.execute(
        'CREATE TABLE IF NOT EXISTS edits (seq INTEGER PRIMARY KEY, client TEXT NOT NULL, pos INTEGER NOT NULL, text TEXT NOT NULL)',
      )
    },
  }),
  events: { edit: event<Edit>() },
  createVars: () => ({ text: '', version: 0 }),
  // the text lives in memory; rebuilt from the edits when the actor wakes
  onWake: async (c) => {
    const rows = await c.db.execute<Edit>('SELECT seq, client, pos, text FROM edits ORDER BY seq')
    for (const row of rows) {
      c.vars.text = c.vars.text.slice(0, row.pos) + row.text + c.vars.text.slice(row.pos)
      c.vars.version = row.seq
    }
  },
  actions: {
    /** One keystroke: one edit row in its own transaction, then sent to everyone connected. */
    insert: async (c, edit: { client: string; pos: number; text: string }) => {
      // (one typist in this demo; concurrent inserts would need ordering)
      const seq = c.vars.version + 1
      await c.db.transaction(async (tx) => {
        await tx.execute('INSERT INTO edits (seq, client, pos, text) VALUES (?, ?, ?, ?)', seq, edit.client, edit.pos, edit.text)
      }, { name: 'insert' })
      c.vars.version = seq
      c.vars.text = c.vars.text.slice(0, edit.pos) + edit.text + c.vars.text.slice(edit.pos)
      c.broadcast('edit', { seq, ...edit })
      return seq
    },
    read: (c) => ({ version: c.vars.version, text: c.vars.text }),
  },
})

export const registry = setup({ use: { textFile } })
export type Registry = typeof registry
