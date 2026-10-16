/** Both setText and setChatNode insert at the caret. Use the public reset API
 * to replace plain text and discard undo history from another conversation. */
export interface ChatSender {
  getModelValue(): { text: string };
  getSender(): {
    reset(options: {
      chatNode: Array<Array<{ type: "Write"; text: string }>>;
      clearHistory: boolean;
    }): Promise<void>;
  } | null;
}
export async function replaceSenderText(sender: ChatSender, value: string) {
  if (sender.getModelValue().text === value) return;
  await sender.getSender()?.reset({
    chatNode: value
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((text) => [{ type: "Write", text }]),
    clearHistory: true,
  });
}
