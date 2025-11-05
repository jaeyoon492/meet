'use client';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useMaybeRoomContext } from '@livekit/components-react';
import { RoomEvent, Participant, DataPacket_Kind } from 'livekit-client';
import { fetchChatHistory, type Message as HistoryMessage } from '@/lib/chat-api';
// Tailwind migration: replaced styles/TranslationBubbles.module.css with utility classes

/** 역할 구분: 사용자가 말한 전사인지, 에이전트 발화/텍스트인지 구분 */
type Role = 'user' | 'agent';

export interface Bubble {
  /** 세그먼트(발화) 단위의 고유 식별자. 전사 stream의 lk.segment_id와 동일하게 맞추는 것이 이상적 */
  id: string;

  /** 말한 사람 (LiveKit identity) */
  fromIdentity: string;

  /** 말한 사람 (표시명) */
  fromName: string;

  /** user(참가자) or agent(시스템) */
  role: Role;

  /** 말풍선 시작 시각(ms) */
  startedAt: number;

  /** 전사(원문) */
  transcript: string;
  transcriptFinal: boolean;

  /** 번역문 */
  translation: string;
  translationFinal: boolean;

  /** 번역문 하이라이트 범위(절대 오프셋, [start,end)) */
  translationHighlights: HighlightRange[];
}

/* -------------------------------------------------------------------------- */
/* 유틸리티 함수들                                                             */
/* -------------------------------------------------------------------------- */

/** 초/불명확 → ms 로 표준화 */
function toMilliseconds(t?: number): number {
  if (t === undefined || t === null) return Date.now();
  return t > 10_000_000_000 ? t : Math.round(t * 1000);
}

/** 참가자 이름 해석 */
function resolveParticipantName(room: any, identity: string): string {
  return (
    room?.remoteParticipants.get(identity)?.name ??
    (room?.localParticipant.identity === identity ? room?.localParticipant.name : undefined) ??
    identity
  );
}

/** JSON 페이로드 안전 파싱 */
function safeParseJSON(payload: Uint8Array): any | null {
  try {
    return JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return null;
  }
}

/** 증분/누적/중복을 고려한 텍스트 병합 (overlap-aware) */
function mergeIncrementalText(previous: string, incoming: string): string {
  if (!incoming) return previous;
  if (!previous) return incoming;
  if (incoming.startsWith(previous)) return incoming; // 누적 전체본이면 교체

  const max = Math.min(previous.length, incoming.length);
  for (let k = max; k > 0; k--) {
    if (previous.endsWith(incoming.slice(0, k))) {
      return previous + incoming.slice(k);
    }
  }
  return previous + incoming; // 완전히 별개 조각인 드문 경우
}

/** 임시 버블 ID 생성(번역이 먼저 왔을 때) */
function makeTempBubbleId(): string {
  return `temp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

/* ------------------------------ 하이라이트 유틸 ------------------------------ */

export type HighlightRange = {
  start: number;
  end: number;
  label?: string;
  canonical?: string | string[];
  matched?: string;
  matchedVariants?: string[];
};

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function normalizeCanonical(
  input: string | string[] | null | undefined,
): string | string[] | undefined {
  const list = Array.isArray(input) ? uniqueStrings(input) : uniqueStrings([input]);
  if (list.length === 0) return undefined;
  return list.length === 1 ? list[0] : list;
}

function mergeCanonical(
  base?: string | string[],
  incoming?: string | string[],
): string | string[] | undefined {
  const merged = uniqueStrings([
    ...(Array.isArray(base) ? base : base ? [base] : []),
    ...(Array.isArray(incoming) ? incoming : incoming ? [incoming] : []),
  ]);
  if (merged.length === 0) return undefined;
  return merged.length === 1 ? merged[0] : merged;
}

function mergeVariantLists(base?: string[], incoming?: string[]): string[] | undefined {
  const merged = uniqueStrings([...(base ?? []), ...(incoming ?? [])]);
  return merged.length ? merged : undefined;
}

function deserializeHighlightRange(raw: any, offsetBase = 0): HighlightRange | null {
  if (!raw) return null;
  const start = offsetBase + Number(raw.start ?? 0);
  const end = offsetBase + Number(raw.end ?? 0);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;

  const label = typeof raw.label === 'string' && raw.label.trim().length ? raw.label : undefined;

  const canonical = normalizeCanonical(raw.canonical);

  const matched =
    typeof raw.matched === 'string' && raw.matched.trim().length ? raw.matched : undefined;
  const variantsInput = Array.isArray(raw.matchedVariants)
    ? raw.matchedVariants
    : Array.isArray(raw.matched_variants)
    ? raw.matched_variants
    : [];
  const matchedVariants = mergeVariantLists(
    uniqueStrings(variantsInput),
    matched ? [matched] : undefined,
  );

  return {
    start,
    end,
    label,
    canonical,
    matched,
    matchedVariants,
  };
}

/**
 * text에 대해 ranges([start,end))를 안전하게 적용하여 ReactNode 조각 배열 생성
 * - 중첩은 서버에서 병합되어 오므로 그대로 분할/래핑
 * - out-of-bound 범위는 클램프
 */
function canonicalToAttr(value?: string | string[]): string | undefined {
  if (!value) return undefined;
  const list = Array.isArray(value) ? value : [value];
  const normalized = uniqueStrings(list);
  if (!normalized.length) return undefined;
  return normalized.join(', ');
}

function applyHighlights(text: string, ranges?: HighlightRange[]): React.ReactNode {
  if (!text) return null;
  const len = text.length;
  const rs = Array.isArray(ranges)
    ? [...ranges]
        .map((r) => ({
          ...r,
          start: Math.max(0, Number.isFinite(r.start) ? r.start : 0),
          end: Math.max(0, Number.isFinite(r.end) ? r.end : 0),
        }))
        .filter((r) => r.end > r.start && r.start < len)
        .map((r) => ({ ...r, end: Math.min(len, r.end) }))
        .sort((a, b) => a.start - b.start || a.end - b.end)
    : [];
  if (rs.length === 0) return text;

  const out: React.ReactNode[] = [];
  let cursor = 0;
  for (const r of rs) {
    if (cursor < r.start) {
      out.push(text.slice(cursor, r.start));
    }
    const cls = `hl ${r.label ? r.label : 'keyword'}`;
    const canonicalAttr = canonicalToAttr(r.canonical);
    const variantsAttr = Array.isArray(r.matchedVariants)
      ? uniqueStrings(r.matchedVariants).join(', ')
      : undefined;
    const dataAttrs: Record<string, string> = {};
    if (canonicalAttr) dataAttrs['data-canonical'] = canonicalAttr;
    if (variantsAttr) dataAttrs['data-variants'] = variantsAttr;
    if (r.matched) dataAttrs['data-matched'] = r.matched;
    const keyParts = [String(r.start), String(r.end), r.label ?? 'k', canonicalAttr ?? ''];
    out.push(
      <span
        className={cls}
        key={keyParts.join(':')}
        title={canonicalAttr ?? undefined}
        {...dataAttrs}
      >
        {text.slice(r.start, r.end)}
      </span>,
    );
    cursor = r.end;
  }
  if (cursor < len) out.push(text.slice(cursor));
  // 렌더 안전장치: 계산된 조각이 비어있으면 원문 반환
  if (out.length === 0) return text;
  return <>{out}</>;
}

/** ranges 병합/중복 제거(겹침 없음이 보장되지만 중복 항목은 제거) */
function mergeRanges(prev: HighlightRange[], next: HighlightRange[]): HighlightRange[] {
  if (!prev?.length) return next ? [...next] : [];
  if (!next?.length) return prev ? [...prev] : [];

  const byKey = new Map<string, HighlightRange>();
  const pushRange = (range: HighlightRange) => {
    if (!Number.isFinite(range.start) || !Number.isFinite(range.end)) return;
    const key = `${range.start}:${range.end}:${range.label ?? ''}`;
    const normalizedVariants = mergeVariantLists(
      range.matchedVariants,
      range.matched ? [range.matched] : undefined,
    );
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        ...range,
        canonical: normalizeCanonical(range.canonical),
        matchedVariants: normalizedVariants,
      });
      return;
    }
    existing.canonical = mergeCanonical(existing.canonical, range.canonical);
    existing.matched = existing.matched ?? range.matched;
    const mergedVariants = mergeVariantLists(existing.matchedVariants, normalizedVariants);
    existing.matchedVariants = mergedVariants;
  };

  for (const item of prev) pushRange(item);
  for (const item of next) pushRange(item);

  return Array.from(byKey.values())
    .map((r) => ({
      ...r,
      canonical: normalizeCanonical(r.canonical),
      matchedVariants: r.matchedVariants ? uniqueStrings(r.matchedVariants) : undefined,
    }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

/** offset_base 위치에 chunk를 교체 삽입(append 호환) */
function applyChunkAtOffset(buf: string, chunk: string, offsetBase: number): string {
  const offset = Math.max(0, Math.min(offsetBase ?? buf.length, buf.length));
  const before = buf.slice(0, offset);
  const afterStart = offset + chunk.length;
  const after = buf.length > afterStart ? buf.slice(afterStart) : '';
  return before + chunk + after;
}

/* -------------------------------------------------------------------------- */
/* 메인 컴포넌트                                                               */
/* -------------------------------------------------------------------------- */

export default function TranslationRealtime({ selfName }: { selfName: string }) {
  const room = useMaybeRoomContext();

  /** 말풍선 저장(중복 생성 방지), 렌더는 버전 카운터로 트리거 */
  const bubbleMapRef = useRef<Map<string, Bubble>>(new Map());
  const [version, setVersion] = useState(0);

  /** 히스토리 + 라이브 메시지 + 라이브 버퍼 (가이드 준수용 보조 상태) */
  const [history, setHistory] = useState<HistoryMessage[]>([]);
  const [liveMessages, setLiveMessages] = useState<HistoryMessage[]>([]);

  /** 동일 세그먼트에 대한 중복 청크 필터 */
  const lastTranscriptionPieceById = useRef<Map<string, string>>(new Map());
  const lastTranslationPieceById = useRef<Map<string, string>>(new Map());

  /** 업서트 도우미들 */
  function setBubble(id: string, next: Bubble) {
    bubbleMapRef.current.set(id, next);
    setVersion((v) => v + 1);
  }
  function getBubble(id?: string): Bubble | undefined {
    return id ? bubbleMapRef.current.get(id) : undefined;
  }
  function ensureBubble(id: string, seed: Bubble): Bubble {
    const existing = bubbleMapRef.current.get(id);
    if (existing) return existing;
    setBubble(id, seed);
    return seed;
  }

  /* ------------------------------- 초기 히스토리 로드 ------------------------------- */
  useEffect(() => {
    let aborted = false;
    async function load() {
      try {
        const roomName = (room as any)?.name as string | undefined;
        if (!roomName) return; // 연결 전이면 대기
        const msgs = await fetchChatHistory(roomName, 'all', 100);
        if (aborted) return;
        // 시간 오름차순 정렬
        const sorted = [...msgs].sort(
          (a, b) => toMilliseconds(a.datetime) - toMilliseconds(b.datetime),
        );
        setHistory(sorted);

        // 버블 스토어에 반영(현재 렌더러와 형식 맞추기)
        sorted.forEach((m, idx) => {
          const id = `hist-${toMilliseconds(m.datetime)}-${idx}`;
          const fromIdentity = m.speaker;
          const fromName = resolveParticipantName(room, fromIdentity);
          const startedAt = toMilliseconds(m.datetime);
          const bubble: Bubble = {
            id,
            fromIdentity,
            fromName,
            role: 'user',
            startedAt,
            transcript: m.text ?? '',
            transcriptFinal: true,
            translation: m.translated ?? '',
            translationFinal: Boolean(m.translated),
            translationHighlights: [],
          };
          bubbleMapRef.current.set(id, bubble);
        });
        setVersion((v) => v + 1);
      } catch (e) {
        console.warn('[history] failed to load:', e);
        // 히스토리가 비어있을 수 있음(TTL 등). 필요 시 UI 안내
      }
    }
    load();
    return () => {
      aborted = true;
    };
  }, [room]);

  useEffect(() => {
    if (!room) return;

    const handleTranslationData = (data: any, fromIdentity: string, fromName: string) => {
      console.log('Translation_Data: ', data);
      const bubbleId: string = data.seg_id || makeTempBubbleId();
      const startedAt = toMilliseconds(data.timestamp ?? Date.now());

      const seed: Bubble = {
        id: bubbleId,
        fromIdentity,
        fromName,
        role: 'user',
        startedAt,
        transcript: data.original || '',
        transcriptFinal: Boolean(data.original),
        translation: '',
        translationFinal: false,
        translationHighlights: [],
      };
      const bubble = ensureBubble(bubbleId, seed);

      if (data.type === 'translation_error') {
        console.warn('[translation_error]', data.message);
        const id = `err-${Date.now()}`;
        const errorBubble: Bubble = {
          id,
          fromIdentity,
          fromName: fromName || 'System',
          role: 'agent',
          startedAt,
          transcript: '',
          transcriptFinal: true,
          translation: data.message || 'Translation error occurred.',
          translationFinal: true,
          translationHighlights: [],
        };
        setBubble(id, errorBubble);
        return;
      }

      if (data.type === 'translation_live') {
        const piece = String(data.text ?? '');
        const offsetBase = Number.isFinite(data.offset_base)
          ? Number(data.offset_base)
          : bubble.translation.length;

        const dedupKey = `${offsetBase}:${piece}`;
        if (lastTranslationPieceById.current.get(bubbleId) === dedupKey) return;
        lastTranslationPieceById.current.set(bubbleId, dedupKey);

        const updatedText = applyChunkAtOffset(bubble.translation, piece, offsetBase);

        const incRanges: HighlightRange[] = Array.isArray(data.highlights)
          ? data.highlights
              .map((r: any) => deserializeHighlightRange(r, offsetBase))
              .filter((r: any): r is HighlightRange => r != null)
          : [];
        const mergedRanges = mergeRanges(bubble.translationHighlights ?? [], incRanges);

        setBubble(bubbleId, {
          ...bubble,
          translation: updatedText,
          translationFinal: false,
          translationHighlights: mergedRanges,
          startedAt: Math.min(bubble.startedAt, startedAt),
        });
        return;
      }

      const finalText =
        typeof data.final_text === 'string'
          ? data.final_text
          : typeof data.text === 'string'
          ? data.text
          : bubble.translation;
      const finalRanges: HighlightRange[] = Array.isArray(data.highlights)
        ? data.highlights
            .map((r: any) => deserializeHighlightRange(r))
            .filter((r: any): r is HighlightRange => r != null)
        : [];

      const next: Bubble = {
        ...bubble,
        translation: finalText,
        translationFinal: true,
        translationHighlights: finalRanges,
        startedAt: Math.min(bubble.startedAt, startedAt),
      };
      if (data.original) {
        next.transcript = String(data.original);
        next.transcriptFinal = true;
      }
      setBubble(bubbleId, next);

      const msg: HistoryMessage = {
        speaker: fromIdentity,
        text: String(data.original ?? ''),
        translated: String(finalText ?? ''),
        datetime: Math.floor(
          (data.timestamp ?? Date.now()) * (data.timestamp > 10_000_000_000 ? 1 : 0.001),
        ),
      };
      setLiveMessages((prev) => [...prev, msg]);
    };

    const handleTranscriptionData = (data: any, fromIdentity: string, fromName: string) => {
      if (!['transcription_live', 'transcription_final'].includes(data.type)) return;

      console.log('Transcription_Data: ', data);

      const bubbleId: string = data.seg_id || makeTempBubbleId();
      const startedAt = toMilliseconds(data.timestamp ?? Date.now());

      const seed: Bubble = {
        id: bubbleId,
        fromIdentity,
        fromName,
        role: 'user',
        startedAt,
        transcript: '',
        transcriptFinal: false,
        translation: '',
        translationFinal: false,
        translationHighlights: [],
      };
      const bubble = ensureBubble(bubbleId, seed);

      const piece = String(data.text ?? '');
      if (!piece) return;

      if (data.type === 'transcription_live') {
        if (lastTranscriptionPieceById.current.get(bubbleId) === piece) return;
        lastTranscriptionPieceById.current.set(bubbleId, piece);

        const merged = mergeIncrementalText(bubble.transcript, piece);
        if (merged !== bubble.transcript || bubble.transcriptFinal !== false) {
          setBubble(bubbleId, {
            ...bubble,
            transcript: merged,
            transcriptFinal: false,
            startedAt: Math.min(bubble.startedAt, startedAt),
          });
        }
        return;
      }

      lastTranscriptionPieceById.current.set(bubbleId, piece);

      setBubble(bubbleId, {
        ...bubble,
        transcript: piece,
        transcriptFinal: true,
        startedAt: Math.min(bubble.startedAt, startedAt),
      });
    };

    const onData = (
      payload: Uint8Array,
      participant?: Participant,
      kind?: DataPacket_Kind,
      topic?: string,
    ) => {
      if (topic !== 'translation_stream' && topic !== 'transcription_stream') return;

      const data = safeParseJSON(payload);
      if (!data || typeof data.type !== 'string') return;

      const fromIdentity: string =
        data.fromIdentity || participant?.identity || room.localParticipant.identity;
      const fromName = data.from || resolveParticipantName(room, fromIdentity);

      if (topic === 'transcription_stream') {
        handleTranscriptionData(data, fromIdentity, fromName);
        return;
      }

      handleTranslationData(data, fromIdentity, fromName);
    };

    room.on(RoomEvent.DataReceived, onData);

    return () => {
      room.off(RoomEvent.DataReceived, onData);
    };
  }, [room]);

  /* ------------------------------- 렌더 목록 정렬 ------------------------------- */
  const items = useMemo(() => {
    // 현재 렌더는 Bubble 스토어 기준이나, 히스토리를 버블에 반영했으므로 그대로 정렬/렌더하면 가이드의
    // "history + liveMessages" 효과를 충족한다. (liveMessages는 진단/검사용으로 별도 보유)
    return [...bubbleMapRef.current.values()].sort((a, b) => a.startedAt - b.startedAt).slice(-100);
  }, [version]);

  return (
    <div
      className="relative h-full max-[640px]:h-2/5 max-[640px]:w-full min-h-0 max-[640px]:bottom-0"
      aria-live="polite"
    >
      <div className="w-full h-full absolute z-30 overflow-y-auto bg-dark100 p-3 sm:p-4 border-0 rounded-[20px] text-sm sm:text-[0.95rem] md:mr-2 md:mb-4 mr-0 mb-0 flex flex-col gap-1">
        {history.length === 0 && (
          <div className="text-xs opacity-60 mb-2">No history found (may have expired)</div>
        )}
        {items.map((b) => {
          const isSelfUser = b.fromName === selfName && b.role === 'user';
          const sideClass = isSelfUser
            ? 'max-w-[85%] md:max-w-[70%] px-3 py-2 rounded-2xl text-white inline-block relative self-end bg-sky-600/70'
            : 'max-w-[85%] md:max-w-[70%] px-3 py-2 rounded-2xl text-white inline-block relative self-start bg-white/10';

          const showTranslatingPlaceholder =
            !b.translationFinal && !!b.transcript && b.translation.length === 0;

          return (
            <div key={b.id} className={sideClass}>
              <div className="text-xs opacity-70 mb-1">
                <span className="font-bold mr-1">{b.role === 'agent' ? 'Agent' : b.fromName}</span>
                <span className="ml-1">{new Date(b.startedAt).toLocaleTimeString()}</span>
                {!b.transcriptFinal && <span className="opacity-70"> {'\u2022'} listening…</span>}
              </div>

              {/* 윗줄: 번역 (번역 중이면 placeholder) */}
              <div className="break-words whitespace-pre-wrap">
                {showTranslatingPlaceholder
                  ? '(translating...)'
                  : b.translationHighlights && b.translationHighlights.length > 0
                  ? applyHighlights(b.translation, b.translationHighlights)
                  : b.translation}
              </div>

              {/* 아랫줄: 전사(원문) */}
              {b.transcript && (
                <div className="text-sm opacity-50 mt-1">
                  {b.transcript}
                  {!b.transcriptFinal && <span className="opacity-70"> ▋</span>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
