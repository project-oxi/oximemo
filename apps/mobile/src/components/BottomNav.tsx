import { Laptop, NotebookText, Settings } from "lucide-react";

export type Screen = "notes" | "connection" | "settings";
export function BottomNav({ screen, attention, onScreen }: { screen: Screen; attention: boolean; onScreen: (screen: Screen) => void }) {
  return <nav className="bottom-nav" aria-label="주요 화면">
    {([{ screen: "notes", label: "메모", Icon: NotebookText }, { screen: "connection", label: "PC 연결", Icon: Laptop }, { screen: "settings", label: "설정", Icon: Settings }] as const).map(item => <button key={item.screen} aria-current={screen === item.screen ? "page" : undefined} onClick={() => onScreen(item.screen)}>
      <span className="nav-icon"><item.Icon aria-hidden="true" size={17}/>{item.screen === "connection" && attention && <span className="nav-attention" aria-hidden="true"/>}</span><span>{item.label}</span>
    </button>)}
  </nav>;
}
