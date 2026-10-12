import { describe, expect, it } from "bun:test"

import { sortTableRows } from "../src/lib/table-sort"

describe("sortTableRows", () => {
  it("compares numbers numerically and strings as strings", () => {
    const rows = [
      { id: "ten", number: 10, text: "2" },
      { id: "two", number: 2, text: "10" },
    ]

    expect(sortTableRows(rows, (row) => row.number, "ascending").map((row) => row.id)).toEqual([
      "two",
      "ten",
    ])
    expect(sortTableRows(rows, (row) => row.text, "ascending").map((row) => row.id)).toEqual([
      "two",
      "ten",
    ])
  })

  it("keeps null and NaN last with their original relative order", () => {
    const rows = [
      { id: "null-first", value: null },
      { id: "two", value: 2 },
      { id: "nan-first", value: Number.NaN },
      { id: "one", value: 1 },
      { id: "null-second", value: null },
      { id: "nan-second", value: Number.NaN },
    ]

    expect(sortTableRows(rows, (row) => row.value, "ascending").map((row) => row.id)).toEqual([
      "one",
      "two",
      "null-first",
      "nan-first",
      "null-second",
      "nan-second",
    ])
    expect(sortTableRows(rows, (row) => row.value, "descending").map((row) => row.id)).toEqual([
      "two",
      "one",
      "null-first",
      "nan-first",
      "null-second",
      "nan-second",
    ])
  })

  it("orders mixed types transitively in both directions", () => {
    const rows = [
      { id: "word-z", value: "z" },
      { id: "nan", value: Number.NaN },
      { id: "three", value: 3 },
      { id: "null", value: null },
      { id: "word-a", value: "a" },
      { id: "one", value: 1 },
    ]

    expect(sortTableRows(rows, (row) => row.value, "ascending").map((row) => row.id)).toEqual([
      "one",
      "three",
      "word-a",
      "word-z",
      "nan",
      "null",
    ])
    expect(sortTableRows(rows, (row) => row.value, "descending").map((row) => row.id)).toEqual([
      "word-z",
      "word-a",
      "three",
      "one",
      "nan",
      "null",
    ])
  })

  it("keeps equal rows stable, preserves the input, and restores input order on reset", () => {
    const rows = [
      { id: "same-first", value: "same" },
      { id: "other", value: "other" },
      { id: "same-second", value: "same" },
    ]
    const originalOrder = [...rows]

    const ascending = sortTableRows(rows, (row) => row.value, "ascending")
    const descending = sortTableRows(rows, (row) => row.value, "descending")
    const reset = sortTableRows(rows, (row) => row.value, null)

    expect(ascending.map((row) => row.id)).toEqual(["other", "same-first", "same-second"])
    expect(descending.map((row) => row.id)).toEqual(["same-first", "same-second", "other"])
    expect(reset).toBe(rows)
    expect(rows).toEqual(originalOrder)
  })
})
