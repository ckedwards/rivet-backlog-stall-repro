# A write-only actor's SQLite stalls for ~1 s at its 1,025th commit

A minimal reproduction, its cause and a fix, for RivetKit **3.1.1** with Rivet Engine **3.1.1**
(the binary from `@rivetkit/engine-cli` 3.1.1, started by RivetKit as in local development). The
same code is on `main` (`v3.1.2-rc.7`), and the patch applies to it.

## The bug

An actor that commits one small SQLite transaction per action (`rivetkit/db`), and doesn't read
back, stalls for about a second once in each new actor database: at its 1,025th commit, the engine
refuses the write twice, 500 ms apart, then lets it through. With `RUST_LOG=depot_client=debug`:

```
refusing a filesystem write while the tablet's apply is behind; a slow cold store or compaction is likely holding back memtable flushes   (twice, 500 ms apart)
dropped expired overlay notes; misses on their rows read at or past them dropped=1 through=1 committed=1025 applied=0
```

The tablet's apply isn't behind: the maintainer applies the volume every ~100 ms throughout. Only
the depot client's idea of the applied position is stuck at 0.

## The cause

`depot-client` refuses a write when the writer is more than `MAX_HELD_LAYERS` (1,024) entries
ahead of the applied position it has observed (`filesystem/backlog.rs`,
`shed_unapplied_backlog`). It observes that position only from the maintainer's read replies, so
for a writer that reads nothing, `backlog.rs` sends a probe read once more than 256 layers are
held: `observe_applied` reads the root inode through `state.cold.snapshot`.

For a new volume, `state.cold.snapshot` is an `EmptyColdSnapshot` (`filesystem/client.rs`), "the
cold view of a volume that has never written cold rows": it answers every read locally with
"absent". So the probe never reaches the maintainer, learns nothing, and the observed position
stays at 0 until the writer is 1,024 entries ahead and refused. The empty snapshot is replaced by
the store's claim snapshot on the first floor move, which needs either an applied position (the
thing the probe can't learn) or the volume's first move to cold; in the stall, it's the overlay
notes expiring after the refusals that moves it (`dropped expired overlay notes … through=1`),
and the next read then reaches the maintainer, which answers `applied=1025` at once.

A traced engine shows it (`results/trace-stall.txt`, made with `patches/trace-points.patch`):

```
16:27:54.067  probe             last_seq=806  floor=0 applied_before=0 applied_after=0 elapsed_us=2   <- answered locally
16:27:54.267  maintainer applied from=914 through=915                                              <- the apply is current
16:27:54.482  refusing          last_seq=1025 applied=0
16:27:54.983  probe             last_seq=1025 floor=0 applied_before=0 applied_after=0 elapsed_us=1
16:27:54.983  refusing          last_seq=1025 applied=0
16:27:55.484  maintainer claim read given=Some(1025) cold=0 applied=1025 floor=1 through=1025      <- the first read that reaches it
16:27:55.484  claim read reply  as_of=1025 applied=1025 store_applied=0 elapsed_us=464
```

## A fix

`patches/probe-fix.patch`: probe through the store's claim snapshot at the current floor instead
of `state.cold.snapshot`. It's the same read, but it always asks the maintainer; for a volume that
already has a claim snapshot, it only skips the local layers, which a probe doesn't want anyway.

```rust
pub(super) async fn observe_applied(&self, state: &State, deadline: u64) {
	let probe = self
		.cold_store
		.claim_snapshot(self.key.clone(), state.cold.snapshot.position().clone());
	let _ = probe
		.get_inode(depot_fs_core::ROOT_INO, state.last_seq, deadline)
		.await;
}
```

With it, the first probe (at ~600 commits) raises the observed position to the maintainer's
(`applied_after=569`, in ~0.4 ms), the floor moves and the held layers are released; there are no
refusals. I tested it on this repro, on 6,000 back-to-back commits in my own app (max 37 ms, no
refusals), and with my app's test suite (647 tests) on the patched engine. Built from the 3.1.1
source with the workspace's release settings, but without fat LTO (`lto = false`,
`codegen-units = 64`).

## Results

Each run: a new document, 1,300 keystrokes, one awaited `insert` (one commit) at a time.

| Where | Engine | Runs | Max keystroke | Slow keystrokes | Refusals |
| --- | --- | --- | --- | --- | --- |
| Laptop (Linux, NVMe) | 3.1.1 | 3 | 1,018–1,019 ms | 1 per run, #1019 | 2 per run |
| Laptop | 3.1.1 + fix | 3 | 5.3–8.3 ms | none | none |
| AWS c7i.xlarge, gp3 (Ubuntu 24.04) | 3.1.1 | 3 | 1,008–1,010 ms | 1 per run, #1019 | 2 per run |
| AWS c7i.xlarge, gp3 | 3.1.1 + fix | 3 | 5.3–12.9 ms | none | none |
| AWS, 60 keys/s | 3.1.1 / 3.1.1 + fix | 1 each | 6.7 / 6.0 ms | none | none |

The full output is in `results/laptop.txt` and `results/aws-c7i-xlarge.txt`. The keystroke number
is a few below the commit number because the actor's setup makes the database's first commits.

### How fast the commits have to come

In this repro the stall needs 1,024 commits before the volume's first move to cold, which replaces
the empty snapshot on its own; then the probe works. Back to back (~300–400 commits/s) and at
250/s it stalls every time; at 60 and 120/s the move to cold comes first (around commit 300) and
it doesn't (`results/trace-rescued-by-cold-move.txt` shows that path: `cold=289`, then a probe
that raises `applied` from 0 to 906). In my app, with bigger transactions (~13 KB of pages per
commit), it stalled at about 30, 57 and 110 commits/s on a three-node deployment (engine 3.1.1, S3 cold
storage, gp3), every time, at commit 1,025: there the first move to cold hadn't come 34 s in. I
haven't pinned down why it comes so much later there.

## Run it

```sh
bun install
RUST_LOG=depot_client=debug bun run repro             # add --viewer to watch from a second client
```

Each run deletes `.data/` (the engine's data and logs, git-ignored) and starts a fresh engine on
port 7420 (and 7421), which stops when the script ends; `RIVET_RUN_ENGINE_PORT` in `package.json`
changes it. Without `RUST_LOG` it still stalls; the engine just doesn't log the debug lines. The
full log is in `.data/.rivetkit/var/logs/rivet-engine/`.

Options: `KEYSTROKES=2000` (default 1,300), `KEYS_PER_SECOND=60` (default: back to back).

With another engine binary, such as one built with a patch from `patches/`:

```sh
# in the rivet repository at v3.1.1
git apply /path/to/this/repo/patches/probe-fix.patch
cargo build --release -p rivet-engine
# here
RIVET_ENGINE_BINARY=/path/to/rivet/target/release/rivet-engine RUST_LOG=depot_client=debug bun run repro
```

Expected output, on 3.1.1:

```
engine http://127.0.0.1:7420, document doc-b312c116, typing 1300 characters
slow keystroke #1019: 1019 ms, started 2026-11-25T16:13:53.949Z

1300 keystrokes in 3.38 s (385/s): p50 1.7 ms, p95 2.5 ms, max 1019.2 ms
1 keystroke(s) over 100 ms
document at version 1300, 1300 characters
[engine] … message="refusing a filesystem write while the tablet\'s apply is behind; …" key=… limit=268435456
[engine] … message="refusing a filesystem write while the tablet\'s apply is behind; …" key=… limit=268435456
[engine] … message="dropped expired overlay notes; misses on their rows read at or past them" dropped=1 through=1 committed=1025 applied=0
```

The slow keystroke starts within a millisecond of the first refusal and ends just after the
`committed=1025 applied=0` line. With `--viewer`, the viewer reports
`no edits for ~1000 ms, then edit 1019`.

## Files

- `src/registry.ts`: the `textFile` actor, one per document. Each `insert` (a keystroke) writes one
  row to an `edits` table in its own transaction, updates the text in memory and broadcasts the
  edit; `read` returns the text.
- `src/repro.ts`: starts the registry and a local engine, opens a new document (a new actor and
  database), types into it and prints the latencies, every keystroke over 100 ms and the engine's
  matching log lines.
- `src/viewer.ts`: a second client that prints the text as it changes, and any pause (`--viewer`).
- `patches/probe-fix.patch`: the fix, against `v3.1.1`.
- `patches/trace-points.patch`: the `[TRACE-bk1]` trace points behind `results/trace-*.txt`, in
  `depot-client` (probes, claim reads, refusals) and `depot-worker` (apply pages, claim reads).
- `results/`: the runs above.
