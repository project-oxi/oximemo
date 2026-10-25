import { copilotSend } from "./api";
import { useUI, type CopilotRetryPayload } from "../stores/ui";

/** Own a turn across panel remounts; a reset invalidates only its transcript. */
export async function runCopilotTurn(
  payload: CopilotRetryPayload,
  send: typeof copilotSend = copilotSend,
) {
  const state = useUI.getState();
  if (state.copilotBusy || !payload.message.trim()) return null;
  const epoch = state.copilotEpoch;
  const { message, memo, referenced } = payload;
  const at = Date.now();
  useUI.setState({
    copilotBusy: true,
    copilotStartedAt: at,
    copilotStream: "",
    copilotEntries: [...state.copilotEntries, {
      role: "user", text: message, at,
      attached: {
        active: memo ? { id: memo.id, title: memo.title, path: memo.path } : null,
        selection: memo?.selection ?? null,
        memos: referenced,
      },
    }],
  });
  try {
    const result = await send(message, memo, referenced.length ? referenced : null,
      state.copilotSession, state.copilotModel);
    if (useUI.getState().copilotEpoch === epoch) {
      useUI.setState((s) => ({
        copilotSession: result.session_id ?? s.copilotSession,
        copilotEntries: [...s.copilotEntries, { role: "agent", result, at: Date.now(), retry: result.timed_out || result.signal != null || result.exit_code !== 0 ? payload : undefined }],
      }));
    }
    // Changes still need refreshing even if the conversation was reset.
    if (useUI.getState().copilotEpoch === epoch) {
      // The parsed response replaces the in-flight stream bubble.
      useUI.getState().resetCopilotStream();
    }
    return result;
  } catch (error) {
    if (useUI.getState().copilotEpoch === epoch) {
      useUI.getState().resetCopilotStream();
      useUI.getState().setCopilotEntries((es) => [...es, {
        role: "error", text: String(error).split("\n")[0], at: Date.now(), retry: payload,
      }]);
    }
    return null;
  } finally {
    useUI.setState({ copilotBusy: false, copilotStartedAt: null });
  }
}
