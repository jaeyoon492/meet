'use client';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useMaybeRoomContext } from '@livekit/components-react';
import { RoomEvent, Participant, DataPacket_Kind } from 'livekit-client';
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

/** 전사 스트림 chunk 표준화 */
function normalizeStreamChunk(chunk: any): string {
  if (typeof chunk === 'string') return chunk;
  if (typeof chunk?.current === 'string') return chunk.current;
  return String(chunk ?? '');
}

/** 전사 스트림(info)에서 세그먼트 ID를 최대한 안전하게 추출 */
function extractSegmentId(info: any): string {
  const attrs = (info?.attributes ?? {}) as Record<string, any>;
  return (
    attrs['lk.segment_id'] ||
    attrs['segment_id'] ||
    info?.id || // 엔진/런타임이 부여한 스트림 id
    `seg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
}

/** 임시 버블 ID 생성(번역이 먼저 왔을 때) */
function makeTempBubbleId(): string {
  return `temp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

/* -------------------------------------------------------------------------- */
/* 메인 컴포넌트                                                               */
/* -------------------------------------------------------------------------- */

export default function TranslationRealtime({ selfName }: { selfName: string }) {
  const room = useMaybeRoomContext();

  /** 말풍선 저장(중복 생성 방지), 렌더는 버전 카운터로 트리거 */
  const bubbleMapRef = useRef<Map<string, Bubble>>(new Map());
  const [version, setVersion] = useState(0);

  /** 동일 세그먼트에 대한 중복 청크 필터 */
  const lastTranscriptionPieceById = useRef<Map<string, string>>(new Map());
  const lastTranslationPieceById = useRef<Map<string, string>>(new Map());

  /** 화자별 “열린 버블”(최근 생성된 세그먼트). seg_id 없는 번역이 붙을 자리 */
  const currentOpenBubbleIdBySpeaker = useRef<Map<string, string>>(new Map());

  /** 번역이 먼저 오고 전사가 나중에 오는 경우, 입양 대기 중인 임시 버블 ID */
  const pendingTempBubbleIdBySpeaker = useRef<Map<string, string>>(new Map());

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

  useEffect(() => {
    if (!room) return;

    /* ----------------------------- 번역 수신 핸들러 ----------------------------- */
    const onData = (
      payload: Uint8Array,
      participant?: Participant,
      kind?: DataPacket_Kind,
      topic?: string,
    ) => {
      // 1) 번역 토픽만 처리
      if (topic !== 'translation_stream') return;

      const data = safeParseJSON(payload);
      if (
        !data ||
        !['translation_live', 'translation_final', 'translation_error'].includes(data.type)
      ) {
        return;
      }

      // 2) 화자 식별
      const fromIdentity: string =
        data.fromIdentity || participant?.identity || room.localParticipant.identity;
      const fromName = data.from || resolveParticipantName(room, fromIdentity);

      // 3) 세그먼트 ID 결정: 백엔드가 seg_id를 못 붙인 경우 열린 버블로 폴백
      const preferredSegId: string | undefined = data.seg_id;
      const fallbackOpenSegId = currentOpenBubbleIdBySpeaker.current.get(fromIdentity);
      const bubbleId = preferredSegId || fallbackOpenSegId || makeTempBubbleId();

      // 4) 버블 존재 보장 (번역이 먼저 오면 임시 버블로 만든다)
      const seed: Bubble = {
        id: bubbleId,
        fromIdentity,
        fromName,
        role: 'user', // 번역은 보통 user 발화의 결과를 의미
        startedAt: Date.now(),
        transcript: data.original || '',
        transcriptFinal: Boolean(data.original),
        translation: '',
        translationFinal: false,
      };
      const bubble = ensureBubble(bubbleId, seed);

      // 5) 번역 병합/상태 갱신
      if (data.type === 'translation_error') {
        // 필요 시 에러 상태 UI 처리 가능(여기서는 로그만)
        console.warn('[translation_error]', data.message);
        return;
      }

      if (data.type === 'translation_live') {
        const piece = String(data.text ?? '');
        // 간단한 중복 필터(같은 조각 연속 수신 차단)
        if (lastTranslationPieceById.current.get(bubbleId) === piece) return;
        lastTranslationPieceById.current.set(bubbleId, piece);

        const merged = mergeIncrementalText(bubble.translation, piece);
        if (merged !== bubble.translation || bubble.translationFinal !== false) {
          setBubble(bubbleId, { ...bubble, translation: merged, translationFinal: false });
        }
      } else {
        // translation_final 또는 legacy translation (최종)
        let nextTranslation = bubble.translation;
        if (data.text) {
          nextTranslation = mergeIncrementalText(nextTranslation, String(data.text));
        }
        const next: Bubble = {
          ...bubble,
          translation: nextTranslation,
          translationFinal: true,
        };
        if (data.original) {
          next.transcript = String(data.original);
          next.transcriptFinal = true;
        }
        setBubble(bubbleId, next);
      }
    };

    room.on(RoomEvent.DataReceived, onData);

    /* ---------------------------- 전사(TextStream) 핸들러 ---------------------------- */
    const onTranscription = async (reader: any, pinfo: { identity: string }) => {
      const info = reader?.info ?? {};
      const attrs = (info.attributes ?? {}) as Record<string, any>;

      // 1) 버블ID 추출(가능하면 lk.segment_id)
      const bubbleId = extractSegmentId(info);
      const startedAt = toMilliseconds(info.timestamp);

      // 2) 화자 정보
      const fromIdentity: string = pinfo.identity;
      const fromName = resolveParticipantName(room, fromIdentity);
      const role: Role = attrs['lk.transcribed_track_id'] ? 'user' : 'agent';

      // 3) 번역이 먼저 온 임시 버블이 있다면 입양 → 정식 ID로 승격
      const pendingTempId = pendingTempBubbleIdBySpeaker.current.get(fromIdentity);
      let bubble = getBubble(bubbleId);
      if (!bubble) {
        if (pendingTempId && getBubble(pendingTempId)) {
          const tmp = getBubble(pendingTempId)!;
          bubbleMapRef.current.delete(pendingTempId);
          pendingTempBubbleIdBySpeaker.current.delete(fromIdentity);
          bubble = {
            ...tmp,
            id: bubbleId,
            role,
            startedAt: Math.min(tmp.startedAt, startedAt),
          };
          setBubble(bubbleId, bubble);
        } else {
          bubble = ensureBubble(bubbleId, {
            id: bubbleId,
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

      // 4) 이 화자의 “열린 버블”로 등록(seg_id 없는 번역은 여기에 붙음)
      currentOpenBubbleIdBySpeaker.current.set(fromIdentity, bubbleId);

      // 5) 부분 전사 누적(증분/누적/중복 안전 처리)
      for await (const chunk of reader) {
        const piece = normalizeStreamChunk(chunk);
        if (!piece) continue;

        // 동일 조각 연속 필터
        if (lastTranscriptionPieceById.current.get(bubbleId) === piece) continue;
        lastTranscriptionPieceById.current.set(bubbleId, piece);

        const current = getBubble(bubbleId);
        if (!current) continue;

        const merged = mergeIncrementalText(current.transcript, piece);
        if (merged !== current.transcript || current.transcriptFinal !== false) {
          setBubble(bubbleId, { ...current, transcript: merged, transcriptFinal: false });
        }
      }

      // 6) 스트림 종료 → final 플래그 갱신
      const current = getBubble(bubbleId);
      if (current) {
        const isFinal = Boolean(attrs['lk.transcription_final'] ?? true);
        if (current.transcriptFinal !== isFinal) {
          setBubble(bubbleId, { ...current, transcriptFinal: isFinal });
        }
      }
    };

    room.registerTextStreamHandler('lk.transcription', onTranscription);

    return () => {
      room.off(RoomEvent.DataReceived, onData);
      room.unregisterTextStreamHandler('lk.transcription');
    };
  }, [room]);

  /* ------------------------------- 렌더 목록 정렬 ------------------------------- */
  const items = useMemo(() => {
    return [...bubbleMapRef.current.values()].sort((a, b) => a.startedAt - b.startedAt).slice(-30); // 최근 30개만
  }, [version]);

  return (
    <div
      className="relative h-full max-[640px]:h-2/5 max-[640px]:w-full min-h-0 max-[640px]:bottom-0"
      aria-live="polite"
    >
      <div className="w-full h-full absolute z-30 overflow-y-auto bg-dark100 p-3 sm:p-4 border-0 rounded-[20px] text-sm sm:text-[0.95rem] md:mr-2 md:mb-4 mr-0 mb-0 flex flex-col gap-1">
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
              <div className="break-words">
                {showTranslatingPlaceholder ? '(translating...)' : b.translation}
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
