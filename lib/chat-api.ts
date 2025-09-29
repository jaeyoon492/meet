export type Message = {
  speaker: string;
  text: string;
  translated?: string;
  datetime: number; // seconds or ms; normalized by caller
};

export type HistoryResponse = { messages: Message[] } | Message[];

const BASE = process.env.NEXT_PUBLIC_API_BASE;

export async function fetchChatHistory(
  roomName: string,
  speaker: string = 'all',
  limit: number = 100,
): Promise<Message[]> {
  const url = new URL('/chat/history', BASE);
  url.searchParams.set('room_name', roomName);
  url.searchParams.set('speaker', speaker);
  url.searchParams.set('limit', String(limit));

  const res = await fetch(url.toString(), { method: 'GET' });
  if (!res.ok) {
    throw new Error(`history fetch failed: ${res.status}`);
  }
  const data: HistoryResponse = await res.json();
  const messages = Array.isArray(data) ? data : data.messages;
  if (!Array.isArray(messages)) return [];
  return messages.filter(Boolean);
}
