import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { imageMime } from "../lib/references";
import { renderMarkdown } from "../lib/markdown";

export function MarkdownPreview({ body, title, documentKey, onLink }: { body: string; title?: string; documentKey?: string; onLink?: (reference: string) => Promise<void> }) {
  const [attachment, setAttachment] = useState<{ name: string; bytes: number[]; src?: string }>();
  const [loading, setLoading] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  useEffect(() => setCopyStatus(""), [body]);
  const html = useMemo(() => {
    // Suppress only an exact repeated leading H1 in this derived view.
    const heading = body.match(/^(?:[ \t]*\r?\n)* {0,3}# +(.+?)(?: +#+)?[ \t]*(?:\r?\n|$)/);
    const visible = title && heading?.[1].trim() === title.trim() ? body.slice(heading[0].length) : body;
    return renderMarkdown(visible);
  }, [body, title]);
  const copyCode = async (event: React.MouseEvent<HTMLElement>) => {
    const reference = (event.target as HTMLElement).closest("button.markdown-reference, button.markdown-attachment") as HTMLButtonElement | null;
    if (reference && event.currentTarget.contains(reference)) {
      if (loading) return;
      setLoading(true); setCopyStatus("");
      try {
        const target = reference.title;
        if (reference.classList.contains("markdown-reference") && !(/^pdc:\/\/asset\//.test(target) || !/^[a-z][\w+.-]*:/i.test(target) && /\.(?!md$|html$|djot$)[a-z0-9]+$/i.test(target))) {
          if (!onLink) throw new Error("목록에서 메모를 다시 열어 주세요.");
          await onLink(target);
        } else {
          if (/^https?:\/\//i.test(target)) { await invoke("mobile_open_link", { url: target }); return; }
          if (!documentKey) throw new Error("첨부를 보려면 메모를 저장하고 PC와 동기화해 주세요.");
          const file = await invoke<{ name: string; bytes: number[] }>("mobile_attachment", { key: documentKey, reference: decodeURIComponent(target.startsWith("wiki:") ? target.slice(5) : target) });
          const mime = imageMime(file.bytes);
          let src: string | undefined;
          if (mime) {
            let binary = "";
            for (let i = 0; i < file.bytes.length; i += 8192) binary += String.fromCharCode(...file.bytes.slice(i, i + 8192));
            src = `data:${mime};base64,${btoa(binary)}`;
          }
          setAttachment({ ...file, src });
        }
      } catch (error) { setCopyStatus(String(error).replace(/^Error:\s*/, "")); }
      finally { setLoading(false); }
      return;
    }
    const button = (event.target as HTMLElement).closest("button.markdown-copy");
    if (!button || !event.currentTarget.contains(button)) return;
    const code = button.closest("figure")?.querySelector("pre code");
    if (!code) return;
    try {
      if (!window.navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await window.navigator.clipboard.writeText(code.textContent || "");
      // The controls live inside sanitized generated HTML, outside React's child tree.
      if (button.isConnected) button.textContent = "복사됨";
      setCopyStatus("코드를 복사했어요.");
    } catch {
      if (button.isConnected) button.textContent = "복사 실패";
      setCopyStatus("복사하지 못했어요. 코드 내용을 길게 눌러 선택해 주세요.");
    }
  };
  return body.trim()
    ? <><article className="markdown-body" aria-label="메모 본문" onClick={copyCode} dangerouslySetInnerHTML={{ __html: html }}/>{attachment && <figure className="mobile-attachment-preview">{attachment.src ? <img src={attachment.src} alt={attachment.name} onError={() => setCopyStatus("이미지를 표시하지 못했어요.")}/> : <p>이 형식은 PC에서 열어 주세요.</p>}<figcaption>{attachment.name} · {Math.ceil(attachment.bytes.length / 1024)} KB<button type="button" onClick={() => setAttachment(undefined)}>닫기</button></figcaption></figure>}<p className="markdown-copy-status" role="status">{loading ? "불러오는 중…" : copyStatus}</p></>
    : <p className="markdown-empty">내용 없음</p>;
}
