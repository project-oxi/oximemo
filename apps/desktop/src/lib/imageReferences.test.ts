import { describe, expect, test } from "bun:test";
import { imageReferenceAt, resizedImageReference } from "./imageReferences";

describe("editing rendered image instances", () => {
  test("deleting one reference preserves prose and the duplicate beside it", () => {
    const doc = "앞 ![첫](oximg://localhost/a.png) 사이 ![둘](oximg://localhost/a.png) 뒤\n다음";
    const anchor = doc.indexOf("\n");
    const second = imageReferenceAt(doc, "a.png", anchor, 1)!;
    expect(doc.slice(0, second.from) + doc.slice(second.to)).toBe("앞 ![첫](oximg://localhost/a.png) 사이  뒤\n다음");
  });

  test("width reset changes only the selected reference", () => {
    const doc = "![첫](oximg://localhost/a.png#w=120)\n![둘](oximg://localhost/a.png#w=240)";
    const second = imageReferenceAt(doc, "a.png", doc.length)!;
    expect(resizedImageReference(second.text, 0)).toBe("![둘](oximg://localhost/a.png)");
    expect(resizedImageReference(second.text, 333)).toBe("![둘](oximg://localhost/a.png#w=333)");
  });
});
