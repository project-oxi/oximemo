import { expect, test } from "bun:test";
import { uploadImageFiles } from "./imageUploads";

test("failed attachments are reported while the rest of a batch completes in order", async () => {
  const files = ["first.png", "unreadable.png", "last.webp"].map((name) => new File(["image"], name));
  const result = await uploadImageFiles(files, async (file) => {
    if (file.name === "unreadable.png") throw new Error("disk full");
    return { name: file.name, url: `oximg://localhost/${file.name}` };
  });
  expect(result.uploaded.map(({ file }) => file.name)).toEqual(["first.png", "last.webp"]);
  expect(result.failed).toEqual(["unreadable.png"]);
});

test("an entirely failed batch produces no source insertion and retains all filenames", async () => {
  const files = ["one.png", "two.jpg"].map((name) => new File(["image"], name));
  const result = await uploadImageFiles(files, async () => { throw new Error("permission denied"); });
  expect(result.uploaded).toEqual([]);
  expect(result.failed).toEqual(["one.png", "two.jpg"]);
});
