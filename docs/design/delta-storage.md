# Delta storage for context updates (design)

Status: **design complete — implementation tracked as board item ARCH-004.**
Companion to API-004, whose near-term layer (context size caps) is shipped:
`MAX_MESSAGES_PER_APPEND = 1000`, `MAX_MESSAGES_PER_CONTEXT = 10_000`
(`packages/core/src/constants.ts`) bound the worst case of the design this
document replaces.

## 1. Problem

The version model is git-like: every operation inserts a new head node
(`type: 'context'`, `context_id = root`, `prev_id = previous head`) and the
version is the head's position in the chain. Heads already come in two
flavours (see `context-chain.ts`):

- **snapshot heads** (`create` / `update` / `delete` today) own a **complete
  copy** of the message state — self-contained;
- **append heads** own only the NEW messages; their first message links via
  `prev_id` into the previous head (zero-copy append, PROM-002).

The O(n) problem: **`update` and `delete-messages` are snapshot heads**. A
single-word edit on an n-message context clones all n rows under the new head
(O(n) inserts; today bounded by `MAX_MESSAGES_PER_CONTEXT = 10_000`).

Append is already delta. This design extends the same mechanism to
update/delete: **patch heads** that own only the change, materialised on
read, with **periodic snapshots** bounding the chain.

## 2. Goals / non-goals

Goals

- O(Δ) writes for update/delete, where Δ = number of affected messages
  (typically 1–3), instead of O(n).
- Reads stay O(1) queries: one batched query for the boundary segment plus
  one batched query for the patch rows (today's `getOrderedNodes` already
  batches the append-chain segment identically).
- **No schema change, no migration.** A patch is stored in existing columns
  (head `content` + `metadata` + the message rows under the head).
- Crash-consistency unchanged: head + its rows go out as ONE `insertNodes`
  statement (the DATA-001 pattern).

Non-goals

- No cross-context or cross-project patching.
- No change to append, create, or permanent-delete behaviour.
- No new storage methods on `StorageAdapter` (all four adapters stay
  untouched — the op layer does the work).

## 3. Model

A third head flavour:

| head | metadata.kind | rows under head | self-contained? |
| --- | --- | --- | --- |
| create / append / snapshot update / snapshot delete | (absent) or `snapshot` | create: full; append: new only; snapshot: full | create/snapshot yes; append no (links into previous head) |
| **patch update** | `patch`, `operation: 'update'` | **only the changed messages** — each with `parent_id` = the pre-patch id | no |
| **patch delete** | `patch`, `operation: 'delete'` | **none** — the resolved message ids live in the head's `content` | no |

Head payload:

- **patch update** — head `content` is `{}` (the changes live in the rows);
  `metadata = { operation: 'update', kind: 'patch', affected: [...],
  child_count }` (same metadata shape as today).
- **patch delete** — head `content = { deleted_ids: [<resolved public ids>] }`;
  `metadata = { operation: 'delete', kind: 'patch', affected: [...],
  child_count: 0 }`.

Ids: a changed message gets a **fresh public id at write time** (generated
when the patch rows are built — exactly like today's clones), with
`parent_id` pointing at the pre-patch id. This keeps the observable rule
"an updated message's id changes" while making the pre-patch id the stable
join key for materialisation. Ids are assigned at **write** time, never at
read time, so repeated reads of a version return identical ids and
delete-by-id stays deterministic.

**Compatibility:** a head without `metadata.kind` (or with `kind: 'snapshot'`)
is treated as self-contained. Legacy databases contain only such heads and
read identically — **no migration**.

## 4. Materialisation (read path)

`getOrderedNodes(storage, rootId, headId)` becomes:

1. Walk the version chain back from `headId`:
   - while the head is an **append** head → current behaviour (cumulative
     content via the `prev_id` link);
   - while the head is a **patch** head (`metadata.kind === 'patch'`) →
     collect it as a patch (newest first);
   - stop at the first **boundary** head (create, snapshot update, snapshot
     delete).
2. `base = getOrderedNodes(boundaryHead)` using the **existing** algorithm
   (one batched `findNonContextNodesByContextIds` for the append segment).
3. One batched `findNonContextNodesByContextIds(patchHeadIds)` fetches all
   patch rows in a single query.
4. Apply patches **oldest → newest** over a working list (initially `base`,
   kept in a `Map<public_id, row>` plus order array):
   - **patch update** — for each row under the patch head (in its `prev_id`
     order): `target = byId.get(row.parent_id)`; remove `target` from the
     working list and splice `row` in at the same position; update the map.
   - **patch delete** — for each id in `content.deleted_ids`: remove
     `byId.get(id)` from the working list.
5. Re-link `prev_id` across the working list and return it as
   `NodeRow`-shaped views (`public_id`, `parent_id`, `prev_id`,
   `created_at`, `content`, `metadata`).

Complexity: **2 queries per read** (boundary segment + patch rows) — the same
query count as today's append-chain walk; the patch application is O(base +
ΣΔ) in memory. The patch chain length is bounded by the snapshot policy
(§6), so the per-read cost is bounded regardless of context age.

All selectors flow through this one function — default get, `?version=`,
`?at=`, `?before=`, `?history=true`, and the write-time reads in
update/delete/append — so time-travel and history remain correct per head.

## 5. Write path

**updateMessages**

1. Validate the body (unchanged).
2. Resolve the head; `current = getOrderedNodes(...)` — materialised state.
3. Resolve `id`/`index` selectors against `current` (unchanged semantics:
   unknown id → 404, bad index → 400).
4. Build the rows for the **affected** messages only: fresh `public_id`,
   `parent_id = pre-patch id`, `content = merge`, `metadata` carried over —
   exactly the row shape today's clones already use.
5. Decide patch vs snapshot (§6). Patch: head + Δ rows in ONE `insertNodes`.
   Snapshot: the **existing** full-clone code path, unchanged.
6. Respond with the materialised state at the new head (same `MessageView`
   shape; affected messages carry their fresh ids, unaffected messages their
   existing ones).

**deleteMessages**

Same, except the head carries `content = { deleted_ids: [...] }` and writes
zero message rows (or a snapshot: the existing code path, which clones the
survivors).

**append / create / permanent delete** — unchanged.

## 6. Snapshot policy (periodic snapshots)

After writing a patch head, count **consecutive** patch heads back from the
new head (stopping at the first non-patch). Write a **snapshot** instead of a
patch when either:

1. `consecutivePatchHeads >= SNAPSHOT_INTERVAL` (default **8**), or
2. the change would touch **more than 50 %** of the context's messages
   (Δ > n/2) — a patch is no longer smaller than a snapshot.

A snapshot is exactly today's full-clone head (`metadata.kind` absent, full
row set under the head), so compaction **reuses existing code** and leaves
the chain in a state every reader (old or new) already understands. Worst
case: a read walks ≤ `SNAPSHOT_INTERVAL` patches. `SNAPSHOT_INTERVAL` is an
exported constant (tunable later via config if a deployment wants a
different space/time tradeoff).

Optional follow-up (out of scope for ARCH-004): a `ultracontext gc` hook or
repair tool that force-compacts old chains on demand.

## 7. FTS / search semantics

Search is **row-level and history-scoped by construction**: each adapter
indexes the message rows that physically exist (SQLite FTS5 maintained
manually in `insertNodes`; Postgres tsvector; Supabase text search), with no
dedupe across versions. A message edited in 3 versions yields up to 3
indexable rows today.

The patch design preserves this **exactly and more cheaply**:

- `insertNodes` continues to index whatever rows are written — a patch
  update writes Δ rows, so Δ FTS rows are added (today: n rows).
- Rows of earlier versions are never deleted by update/delete (true today
  too — only permanent delete clears FTS), so historical search is
  unchanged.
- **No adapter changes.** The op layer simply writes fewer rows.

## 8. Behavioural change (must be called out in the changelog)

Today **every** message in a context gets a new id on each update/delete
(full copy). After this change, **unaffected** messages keep their id across
versions that don't touch them; only affected messages change id (same as
today). This is additive and strictly friendlier (stable identity for
unchanged content) and changes no wire shape — `MessageView` is identical —
but it is a user-visible semantic shift. The core test that pins the old
behaviour ("copies messages onto the new head via copy-on-write" — asserts a
copy per original message, all fresh ids) is rewritten to assert the patch
head stores only the change and that materialisation yields the same
content/order, with stable ids for untouched messages.

## 9. Compatibility & crash consistency

- **No schema change, no migration** (§3). Old binaries read new DBs safely
  up to the first patch head — which old binaries cannot produce — and new
  binaries read old DBs natively. Mixed-version deploys: patch heads are only
  written by new code; a deploy rollback must not roll back below the last
  snapshot (standard caveat, noted in release notes).
- **Crash consistency** (DATA-001): head + rows in one `insertNodes`; a
  crash mid-op leaves the previous head intact. A patch head with missing
  rows is impossible (single statement), and the defensive "broken linked
  list" fallback in `orderNodes` still applies.
- **SSI / API-003**: unchanged — same serializable tx, same conflict
  classification (409 + Retry-After).
- **Caps / API-004**: unchanged and retained as the hard ceiling after this
  lands (the caps bound reads too, and protect against runaway ingestion
  independent of write cost).

## 10. Test plan

Core (MemoryStorage):

- patch update stores only the changed rows under the head (row count = Δ,
  `parent_id` = pre-patch ids, head metadata `kind: 'patch'`).
- materialisation: content, order, and ids — 1-patch, 2-patch (same message
  edited twice), patch→append and append→patch interleavings, delete patch
  (mid, first, last), delete-then-update of a survivor.
- stable ids: untouched message keeps its id across an update that doesn't
  touch it; changed message gets a fresh id; a second read returns identical
  ids.
- selectors on patch chains: `?version=`, `?at=`, `?before=`,
  `?history=true` each return the right materialised state.
- snapshot policy: chain of 8 patches → 9th op writes a snapshot; Δ > n/2
  writes a snapshot immediately; snapshot head has no `kind`.
- caps (API-004) still enforced; SSI conflict still classified (API-003).

Storage (SQLite adapter):

- update of 1 of 100 messages inserts exactly 1 message row + 1 FTS row.
- search hits the new content of an updated message; historical rows remain
  searchable (parity with today's semantics).

API:

- update/delete response shapes unchanged (`MessageView` list + version);
  unaffected ids stable end-to-end.

Regression: the full suite (574 JS + 46 python) must pass with the two
design-pinning tests rewritten as described in §8.

## 11. Risks

1. **Id semantics shift** (§8) — mitigated by the changelog note and the
   test rewrites; no client depends on id-churn of untouched messages (that
   behaviour is a footgun, not a feature — ids are per-version row ids).
2. **Materialisation is now the hottest read path** — 2 batched queries per
   read, bounded patch chain; benchmark via MISC-004 before/after at 10k
   messages.
3. **Rollback window** (§9) — a deploy rollback across un-snapshotted patch
   heads is not supported; release notes must say so.
