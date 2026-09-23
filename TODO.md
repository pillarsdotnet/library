# TODO

Deferred decisions. Each carries the date it was raised and the date to revisit,
so a "wait and see" does not quietly become "forgot about it".

## 2026-09-22 — decide whether to allow fixing a write-blocking defect

**Revisit on or after 2026-09-29** (a week out), or sooner if Open Library
responds to [issue #13708](https://github.com/internetarchive/openlibrary/issues/13708).

### The decision

Whether to add a narrow exception to rule 1 ("only ever fill a blank") for the
case where a record cannot be written *at all* until a defect in it is fixed.

Concrete instance: `OL27239756M` ("The unprotected") has blank
`physical_dimensions` and `physical_format`, but its description ends `"--`,
which Open Library's WAF rejects as an injection signature (#13708). Because the
write API sends the whole record on every PUT, the blank fields cannot be filled
until that description is changed — so filling a blank requires editing a value
someone else entered, which is exactly what rule 1 forbids.

### First, wait

The upstream fix (#13708) makes this whole question moot: if they stop matching
JSON write bodies, the affected rows go through untouched and no rule change is
needed. Do nothing until the week is up.

**Update 2026-09-23: a second case has appeared** — `OL27190384M` ("A Call to
Arms"), same `"--` signature, reported as a comment on #13708. So "one example
is not a pattern" no longer applies; this is a class of MARC-imported records,
and the count will only grow. That strengthens the case for building the
exception if #13708 goes unanswered — but it does **not** change the shape of
what to build or the instinct to prefer the upstream fix. Still wait out the
week first.

### If we do build it

Do **not** relax rule 1 in general. "This value is wrong" is a judgment, and a
judgment applied to a stranger's data on a public catalogue is how contributing
becomes vandalising — which is the whole reason rule 1 exists.

Build it instead as a *sibling* to import and cover-adoption: a distinct,
human-approved exception class, off the automatic path, which keeps rule 1
absolute for the sweep. The safe framing of the rule is:

> Never change a value because it looks wrong. Only ever alter the specific
> bytes that are *provably* preventing a write, and only as much as makes the
> write succeed.

The proof is external and objective — the PUT 403s, and removing this substring
makes it 200 — not an opinion about the text. Constraints that must hold:

- **Never automatic.** The queue shows the exact diff (the description, the
  character range removed, and the 403 that proves it is blocked) and it is
  approved per record. The sweep never does this on its own.
- **"Minimal fix" is still a choice.** The proof says *where* the block is, not
  *what* to do about it (drop the quote, drop the dashes, truncate the tail all
  clear the WAF). A human picks; the app must not.
- **Log it like the destructive actions it resembles** — see
  `ol_send_attempts` and the `applied`/`satisfied` states.

### If it stays a handful of cases

Even with a few (so far `OL27239756M`, `OL27190384M`, and the work
`OL19754718W`), building machinery may be more than it is worth. The by-hand
path still works: strip the trailing quote-and-dashes from each description in
the browser, re-run that record's field sends, and leave rule 1 as it is.
Reserve building the exception for when the by-hand list is long enough to be a
chore, not merely non-empty.

Note the third case is a *work* (`/works/…`) blocking a `series:` tag, not an
edition blocking a physical field — so an exception, if built, has to cover both
record types, and match the signature with optional whitespace (`["'] \s* --`),
not just the adjacent `"--`.
