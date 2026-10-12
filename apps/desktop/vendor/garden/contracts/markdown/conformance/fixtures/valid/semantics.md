---
format: pdc-document/2
body: pdc-markdown/1
id: 018f47c6-7ae7-7aa1-8ed8-8e3df921e7c4
created: 2026-09-14T12:35:00.000Z
updated: 2026-09-14T12:36:00.000Z
title: Semantic v2 document
profile: note
lang: en
tags: [standard, interop]
aliases: [Fixture]
cssclasses: [wide-table]
favorite: true
deleted: false
priority: 3
due: 2026-09-20
reviewed: true
owner: null
x_sawhorse:
  legacy_id: FDR-001
  scores: [1, 2, 3]
---
# Semantic v2 document

## Stable section ^b-018f47c6-7dbe-7a14-9f67-6f89a5e3cc32

[Minimal v1 link](pdc://document/018f47c6-4a77-7c52-9db8-0e5f9bcb17db)

[Minimal relative link](minimal.md)

[[minimal|Wiki link to the minimal document]]

![[minimal]]

Relative image:

![Diagram](assets/diagram.png)

- [ ] Open task ^b-018f47c6-c718-728c-9d91-b2bc700814bb
- [x] Completed task
- [/] In-progress extension state

> [!note] Callout
> Recognized compatibility syntax stays readable.

==Highlighted text== and a #compatibility-tag.

Footnote reference[^1].

[^1]: Footnote body.

Inline math $a^2 + b^2 = c^2$ and a %%source comment%%.

Benign raw HTML stays in source and is inert in preview: <b>bold</b>.

```base
filters:
  and:
    - tags.contains("standard")
    - not:
        - 'deleted == true'
formulas:
  score: "priority * 2"
properties:
  priority:
    displayName: Priority
views:
  - type: table
    name: Standard notes
    limit: 50
    order:
      - file.name
      - note.priority
    summaries:
      note.priority: Average
```
