# Decisions

A decision is worth writing down when someone would otherwise argue about it
again, or quietly change it back. This is where its reason goes.

## 1. Next to the code, when it has a place there

If the decision is about one number, function or file, write the reason in
its doc comment, and say what was turned down:

```ts
/** drag coefficient. Real volleyballs sit ~0.2-0.3 at spike Reynolds numbers: they are past the drag crisis, so not the 0.47 of a smooth sphere */
dragCoefficient: 0.26,
```

A real-court fact also goes in the name of the unit test that checks it
("the middle leaves the floor on the setter's touch"). Most decisions end
here.

## 2. In this directory, when it does not

Write a decision record only when all three are true:

* **No single place in the code can hold it.** It spans several files, or it
  is about something that is deliberately not there.
* **It would surprise a reader.** Without the reason they would wonder why,
  or "fix" it.
* **A real alternative was turned down.**

## Format

* One file per decision: `NNNN-short-slug.md`. The number is the highest one
  here plus one.
* A title that states the decision, then one to three sentences: the
  situation, the decision and why. One paragraph is enough.
* Add a `Considered options` or `Consequences` section only when it says
  something the paragraph does not.
* When a decision changes, write a new record and put
  `Superseded by NNNN` at the top of the old one. Do not rewrite the old one.

This is Michael Nygard's
[architecture decision record](https://www.cognitect.com/blog/2011/11/15/documenting-architecture-decisions),
cut down to its smallest useful form.

## What is not here

How a change was found, measured and fixed goes in its pull request. The
history up to November 2026 is in the old progress log:
`git show a547d9f:PROGRESS.md`.
