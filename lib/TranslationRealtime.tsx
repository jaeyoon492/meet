'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useMaybeRoomContext } from '@livekit/components-react';
import { RoomEvent, Participant, DataPacket_Kind } from 'livekit-client';
import styles from '../styles/TranslationBubbles.module.css';

/** --- Types --- */
type Role = 'user' | 'agent';

interface Bubble {
  /** 동일 발화를 식별하는 키 (권장: STT segment id) */
  id: string;
  fromIdentity: string;
  fromName: string;
  role: Role;
  /** 말풍선 시작 시각(ms). 정렬 및 표시 용도 */
  startedAt: number;
  /** 전사(원문) */
  transcript: string;
  transcriptFinal: boolean;
  /** 번역문 */
  translation: string;
  translationFinal: boolean;
}

/** --- Constants --- */
const ATTACH_WINDOW_MS = 8000;
const MAX_RENDERED_BUBBLES = 30;
const TRANSCRIPTION_TOPIC = 'lk.transcription';
const TRANSLATION_TOPIC = 'translation_stream';

/** --- Utilities --- */

/** s/미확정 -> ms 보정 */
function toMilliseconds(t?: number): number {
  if (!t && t !== 0) return Date.now();
  return t > 10_000_000_000 ? t : Math.round(t * 1000);
}

function resolveParticipantName(room: any, identity: string): string {
  return (
    room?.remoteParticipants.get(identity)?.name ??
    (room?.localParticipant.identity === identity ? room?.localParticipant.name : undefined) ??
    identity
  );
}

function safeParseJSON(payload: Uint8Array): any | null {
  try {
    return JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return null;
  }
}

/** STT stream info에서 segment id 추출 (키 변형/폴백 포함) */
function extractSegmentId(info: any): string {
  const attrs = (info?.attributes ?? {}) as Record<string, any>;
  return (
    attrs['lk.segment_id'] ||
    attrs['segment_id'] ||
    info?.id ||
    `seg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
}

/** 증분/누적/중복이 섞여도 자연스럽게 합치기 */
function mergeIncrementalText(previous: string, incoming: string): string {
  if (!incoming) return previous;
  if (!previous) return incoming;
  if (incoming.startsWith(previous)) return incoming; // 누적본이면 교체
  const overlapMax = Math.min(previous.length, incoming.length);
  for (let k = overlapMax; k > 0; k--) {
    if (previous.endsWith(incoming.slice(0, k))) {
      return previous + incoming.slice(k);
    }
  }
  return previous + incoming; // 완전 별개 조각이면 단순 이어붙임(레어케이스)
}

/** TextStream 청크 표준화 (string | {current: string} | 기타) */
function normalizeStreamChunk(chunk: any): string {
  if (typeof chunk === 'string') return chunk;
  if (typeof chunk?.current === 'string') return chunk.current;
  return String(chunk ?? '');
}

/** 임시 버블 ID */
function makeTemporaryBubbleId(): string {
  return `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** --- Component --- */
export default function TranslationRealtime({ selfName }: { selfName: string }) {
  const room = useMaybeRoomContext();

  /** 버블 저장소(Map) + 렌더 트리거 */
  const bubblesMapRef = useRef<Map<string, Bubble>>(new Map());
  const [renderVersion, setRenderVersion] = useState(0);

  /** 화자별 “열린 버블” (번역 seg_id 없을 때 붙일 후보) */
  const currentOpenBubbleIdBySpeaker = useRef<Map<string, string>>(new Map());

  /** 전사보다 번역이 먼저 온 경우 잠깐 붙여둘 임시 버블 */
  const pendingTemporaryBubbleIdBySpeaker = useRef<Map<string, string>>(new Map());

  /** 중복 청크 방지를 위한 마지막 조각 기록 */
  const lastTranscriptionPieceByBubbleId = useRef<Map<string, string>>(new Map());
  const lastTranslationPieceByBubbleId = useRef<Map<string, string>>(new Map());

  /** --- Map helpers --- */
  function getBubbleById(id?: string): Bubble | undefined {
    return id ? bubblesMapRef.current.get(id) : undefined;
  }

  function upsertBubble(bubble: Bubble): void {
    bubblesMapRef.current.set(bubble.id, bubble);
    setRenderVersion((v) => v + 1);
  }

  function ensureBubbleExists(id: string, init: Omit<Bubble, 'id'>): Bubble {
    const existing = bubblesMapRef.current.get(id);
    if (existing) return existing;
    const created: Bubble = { id, ...init };
    bubblesMapRef.current.set(id, created);
    setRenderVersion((v) => v + 1);
    return created;
  }

  function updateBubble(id: string, updater: (prev: Bubble) => Bubble): void {
    const prev = bubblesMapRef.current.get(id);
    if (!prev) return;
    const next = updater(prev);
    // 내용이 동일하면 렌더 스킵하고 싶다면 shallow compare 추가 가능
    bubblesMapRef.current.set(id, next);
    setRenderVersion((v) => v + 1);
  }

  useEffect(() => {
    if (!room) return;

    /** ─────────────────────────────────────────────────────────────
     * 번역 수신 (DataChannel / JSON)
     * topic: 'translation_stream'
     * type : 'translation_live' | 'translation_final' | 'translation'(legacy)
     * ───────────────────────────────────────────────────────────── */
    const onData = (
      payload: Uint8Array,
      participant?: Participant,
      kind?: DataPacket_Kind,
      topic?: string,
    ) => {
      // topic 필터링으로 타 채널 메시지 혼입 방지
      if (topic !== TRANSLATION_TOPIC) return;

      const data = safeParseJSON(payload);
      if (!data) return;

      const type: string = data.type;
      if (!['translation_live', 'translation_final', 'translation'].includes(type)) return;

      // 발신자
      const fromIdentity: string =
        data.fromIdentity || participant?.identity || room.localParticipant.identity;
      const fromName = data.from || resolveParticipantName(room, fromIdentity);

      // 붙일 버블 결정: seg_id 우선, 없으면 화자의 열린 버블 사용
      let bubbleId: string | undefined =
        data.seg_id || currentOpenBubbleIdBySpeaker.current.get(fromIdentity);
      let target = getBubbleById(bubbleId);

      // 둘 다 없으면 임시 버블 생성 (전사 도착 시 입양)
      if (!target) {
        const tempId = pendingTemporaryBubbleIdBySpeaker.current.get(fromIdentity);
        target = tempId ? getBubbleById(tempId) : undefined;

        if (!target) {
          const newTempId = makeTemporaryBubbleId();
          pendingTemporaryBubbleIdBySpeaker.current.set(fromIdentity, newTempId);
          target = ensureBubbleExists(newTempId, {
            fromIdentity,
            fromName,
            role: 'user',
            startedAt: Date.now(),
            transcript: data.original || '',
            transcriptFinal: Boolean(data.original),
            translation: '',
            translationFinal: false,
          });
        }
        bubbleId = target.id;
      }

      // 내용 병합 (중복 청크 방지)
      const incomingText: string = data.text || '';
      const lastPiece = lastTranslationPieceByBubbleId.current.get(bubbleId!);
      if (incomingText && lastPiece === incomingText) {
        // 동일 조각은 무시
      } else if (type === 'translation_live') {
        lastTranslationPieceByBubbleId.current.set(bubbleId!, incomingText);
        updateBubble(bubbleId!, (b) => ({
          ...b,
          translation: incomingText
            ? mergeIncrementalText(b.translation, incomingText)
            : b.translation,
          translationFinal: false,
        }));
      } else {
        // final 또는 legacy
        lastTranslationPieceByBubbleId.current.set(bubbleId!, incomingText);
        updateBubble(bubbleId!, (b) => {
          const nextTranslation = incomingText
            ? mergeIncrementalText(b.translation, incomingText)
            : b.translation;
          const nextTranscript = data.original ? data.original : b.transcript;
          const nextTranscriptFinal = data.original ? true : b.transcriptFinal;
          return {
            ...b,
            translation: nextTranslation,
            translationFinal: true,
            transcript: nextTranscript,
            transcriptFinal: nextTranscriptFinal,
          };
        });
      }
    };

    /** ─────────────────────────────────────────────────────────────
     * 전사 수신 (TextStream / 스트리밍 텍스트)
     * topic: 'lk.transcription'
     * ───────────────────────────────────────────────────────────── */
    const onTranscription = async (reader: any, pinfo: { identity: string }) => {
      const info = reader?.info || {};
      const attrs = (info.attributes || {}) as Record<string, any>;

      // 버블 키: STT segment id를 권장(환경에 따라 track id까지 네임스페이스화 가능)
      const bubbleId = extractSegmentId(info);

      const fromIdentity = pinfo.identity;
      const fromName = resolveParticipantName(room, fromIdentity);
      const role: Role = attrs['lk.transcribed_track_id'] ? 'user' : 'agent';
      const startedAt = toMilliseconds(info.timestamp);

      // 번역이 먼저 온 경우: 임시 버블을 입양하여 정식 bubbleId로 승격
      const tempId = pendingTemporaryBubbleIdBySpeaker.current.get(fromIdentity);
      let bubble = getBubbleById(bubbleId);

      if (!bubble) {
        if (tempId && getBubbleById(tempId)) {
          const tempBubble = getBubbleById(tempId)!;
          bubblesMapRef.current.delete(tempId);
          pendingTemporaryBubbleIdBySpeaker.current.delete(fromIdentity);
          bubble = {
            ...tempBubble,
            id: bubbleId,
            startedAt: Math.min(tempBubble.startedAt, startedAt),
            role,
          };
          upsertBubble(bubble);
        } else {
          bubble = ensureBubbleExists(bubbleId, {
            fromIdentity,
            fromName,
            role,
            startedAt,
            transcript: '',
            transcriptFinal: false,
            translation: '',
            translationFinal: false,
          });
        }
      }

      // seg_id 없이 온 번역이 붙을 수 있도록 "열린 버블" 등록
      currentOpenBubbleIdBySpeaker.current.set(fromIdentity, bubbleId);

      // 스트림 텍스트 누적
      for await (const chunk of reader) {
        const piece = normalizeStreamChunk(chunk);
        if (!piece) continue;

        // 동일 조각 방지
        const lastPiece = lastTranscriptionPieceByBubbleId.current.get(bubbleId);
        if (lastPiece === piece) continue;
        lastTranscriptionPieceByBubbleId.current.set(bubbleId, piece);

        updateBubble(bubbleId, (prev) => {
          const merged = mergeIncrementalText(prev.transcript, piece);
          if (merged === prev.transcript) return prev; // 내용 동일 시 렌더 스킵
          return { ...prev, transcript: merged, transcriptFinal: false };
        });
      }

      // 스트림 종료 → final 플래그
      const isFinal = Boolean(attrs['lk.transcription_final'] ?? true);
      updateBubble(bubbleId, (prev) => ({ ...prev, transcriptFinal: isFinal }));
    };

    // 등록
    room.on(RoomEvent.DataReceived, onData);
    room.registerTextStreamHandler(TRANSCRIPTION_TOPIC, onTranscription);

    // 해제
    return () => {
      room.off(RoomEvent.DataReceived, onData);
      room.unregisterTextStreamHandler(TRANSCRIPTION_TOPIC);
    };
  }, [room]);

  /** 렌더용 목록: 정렬 + 최근 N개 */
  const items = useMemo(() => {
    return [...bubblesMapRef.current.values()]
      .sort((a, b) => a.startedAt - b.startedAt)
      .slice(-MAX_RENDERED_BUBBLES);
  }, [renderVersion]);

  return (
    <div className={styles.chatWrapper}>
      <div className={styles.bubblesContainer}>
        {items.map((bubble) => {
          const isSelfUser = bubble.fromName === selfName && bubble.role === 'user';
          const sideClassName = isSelfUser ? styles.bubbleRight : styles.bubbleLeft;
          const showTranslatingPlaceholder =
            !bubble.translationFinal && !!bubble.transcript && bubble.translation.length === 0;

          return (
            <div key={bubble.id} className={sideClassName}>
              <div className={styles.meta}>
                <span className={styles.speaker}>
                  {bubble.role === 'agent' ? 'Agent' : bubble.fromName}
                </span>
                <span className={styles.time}>
                  {new Date(bubble.startedAt).toLocaleTimeString()}
                </span>
                {!bubble.transcriptFinal && <span className={styles.partial}> • listening…</span>}
              </div>

              {/* 윗줄: 번역 (진행 중이면 translating...) */}
              <div className={styles.text}>
                {showTranslatingPlaceholder ? '(translating...)' : bubble.translation}
              </div>

              {/* 아랫줄: 전사(원문) */}
              {bubble.transcript && (
                <div className={styles.original}>
                  {bubble.transcript}
                  {!bubble.transcriptFinal && <span className={styles.partial}> ▋</span>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
