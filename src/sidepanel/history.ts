// Conversation history, persisted in chrome.storage.local so it survives panel
// closes. Each conversation is the transcript (user/assistant turns); reopening
// one replays it as context into a fresh CLI session (the native session is
// ephemeral, so "resume" = re-seed the transcript — see App.tsx).

export interface StoredMsg {
  role: "user" | "assistant";
  text: string;
}

export interface Conversation {
  id: string;
  title: string;
  updatedAt: number; // ms epoch
  messages: StoredMsg[];
}

const KEY = "conversations";
const MAX = 60; // keep the newest N; bounds storage on a busy user

export function newConversationId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function deriveTitle(messages: StoredMsg[]): string {
  const firstUser = messages.find((m) => m.role === "user" && m.text.trim());
  const t = (firstUser?.text ?? "").trim().replace(/\s+/g, " ");
  if (!t) return "Conversation";
  return t.length > 60 ? t.slice(0, 60) + "…" : t;
}

async function read(): Promise<Conversation[]> {
  const got = await chrome.storage.local.get(KEY);
  return (got[KEY] as Conversation[]) ?? [];
}

export async function loadConversations(): Promise<Conversation[]> {
  return (await read()).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function saveConversation(conv: Conversation): Promise<void> {
  const list = await read();
  const idx = list.findIndex((c) => c.id === conv.id);
  if (idx >= 0) list[idx] = conv;
  else list.push(conv);
  list.sort((a, b) => b.updatedAt - a.updatedAt);
  await chrome.storage.local.set({ [KEY]: list.slice(0, MAX) });
}

export async function deleteConversation(id: string): Promise<void> {
  const list = (await read()).filter((c) => c.id !== id);
  await chrome.storage.local.set({ [KEY]: list });
}

export async function clearConversations(): Promise<void> {
  await chrome.storage.local.set({ [KEY]: [] });
}
