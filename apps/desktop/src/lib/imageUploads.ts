import type { AssetRef } from "./assets";

/** Keep successful attachments in order and retain every failed filename. */
export async function uploadImageFiles(
  files: readonly File[],
  save: (file: File) => Promise<AssetRef>,
) {
  const uploaded: { file: File; asset: AssetRef }[] = [];
  const failed: string[] = [];
  for (const file of files) {
    try {
      uploaded.push({ file, asset: await save(file) });
    } catch {
      failed.push(file.name);
    }
  }
  return { uploaded, failed };
}
