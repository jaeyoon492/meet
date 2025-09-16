'use client';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useMaybeRoomContext } from '@livekit/components-react';
import { RoomEvent, Participant, RemoteParticipant } from 'livekit-client';
import styles from '../styles/TranslationBubbles.module.css';

type Role = 'user' | 'agent';
interface Bubble {
  id: string; // seg_id == transcription streamId
  fromIdentity: string;
  fromName: string;
  role: Role;
  startedAt: number; // ms
  transcript: string;
  transcriptFinal: boolean;
  translation: string;
  translationFinal: boolean;
}

const ATTACH_WINDOW_MS = 8000;
const toMs = (t?: number) => (t ? (t > 10_000_000_000 ? t : t * 1000) : Date.now());
const nameOf = (room: any, id: string) =>
  room?.remoteParticipants.get(id)?.name ??
  (room?.localParticipant.identity === id ? room?.localParticipant.name : undefined) ??
  id;

// 델타/누적 섞여 들어와도 안전하게 합치기
function smartMerge(prev: string, incoming: string) {
  if (!incoming) return prev;
  if (!prev) return incoming;
  if (incoming.startsWith(prev)) return incoming; // 누적 전체본
  const max = Math.min(prev.length, incoming.length);
  for (let k = max; k > 0; k--) {
    if (prev.endsWith(incoming.slice(0, k))) return prev + incoming.slice(k);
  }
  return prev + incoming;
}

export default function TranslationRealtime({ selfName }: { selfName: string }) {
  const room = useMaybeRoomContext();

  // 1) 버블 저장소(Map)만 관리하고 렌더는 버전 숫자로 트리거
  const mapRef = useRef<Map<string, Bubble>>(new Map());
  const [version, setVersion] = useState(0);
  const upsert = (b: Bubble) => {
    mapRef.current.set(b.id, b);
    setVersion((v) => v + 1);
  };
  const getB = (id?: string) => (id ? mapRef.current.get(id) : undefined);

  // 2) seg_id가 아직 없는 번역을 붙일 “열린 버블” (화자별 최신 세그먼트)
  const openBySpeaker = useRef<Map<string, string>>(new Map());
  // 3) 전사보다 번역이 먼저 온 경우 잠깐 담아둘 임시 버블 id
  const pendingBySpeaker = useRef<Map<string, string>>(new Map());

  // 최근 열린 버블 후보(세그먼트 id 모를 때)
  const pickAttachTarget = (fromIdentity: string) => {
    const now = Date.now();
    const arr = [...mapRef.current.values()]
      .filter((b) => b.fromIdentity === fromIdentity && now - b.startedAt < ATTACH_WINDOW_MS)
      .sort((a, b) => b.startedAt - a.startedAt);
    return arr[0];
  };

  useEffect(() => {
    if (!room) return;

    /** ── 번역 수신 (translation_live / translation_final / legacy translation) ── */
    const onData = (payload: Uint8Array, participant?: Participant) => {
      try {
        const data = JSON.parse(new TextDecoder().decode(payload));
        console.log('data');
        console.log(data);
        if (!data || !['translation_live', 'translation_final', 'translation'].includes(data.type))
          return;

        const fromIdentity: string =
          data.fromIdentity || participant?.identity || room.localParticipant.identity;

        // 1) seg_id가 있으면 그걸로, 없으면 화자의 열린 버블에 붙임
        let segId: string | undefined = data.seg_id || openBySpeaker.current.get(fromIdentity);
        console.log('segId: ', data.seg_id);
        console.log('segId2: ', openBySpeaker.current.get(fromIdentity));
        let target = getB(segId);

        // 2) 그래도 없으면 임시 버블 생성(전사 오면 입양)
        if (!target) {
          const tempId = pendingBySpeaker.current.get(fromIdentity);
          console.log('tempId', tempId);
          target = tempId ? getB(tempId) : undefined;
          if (!target) {
            const id = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
            pendingBySpeaker.current.set(fromIdentity, id);
            target = {
              id,
              fromIdentity,
              fromName: data.from || nameOf(room, fromIdentity),
              role: 'user',
              startedAt: Date.now(),
              transcript: data.original || '',
              transcriptFinal: Boolean(data.original),
              translation: '',
              translationFinal: false,
            };
          }
        }

        // 3) 번역 갱신 (누적/델타 혼용 안전)
        if (data.type === 'translation') {
          // legacy final only
          if (data.text) target.translation = smartMerge(target.translation || '', data.text);
          target.translationFinal = true;
          if (data.original) {
            target.transcript = data.original;
            target.transcriptFinal = true;
          }
        } else if (data.type === 'translation_live') {
          if (data.text) target.translation = smartMerge(target.translation || '', data.text);
          target.translationFinal = false;
        } else if (data.type === 'translation_final') {
          if (data.text) target.translation = smartMerge(target.translation || '', data.text);
          target.translationFinal = true;
        }

        upsert({ ...target });
      } catch (e) {
        console.warn('parse translation payload error', e);
      }
    };
    room.on(RoomEvent.DataReceived, onData);

    /** ── 전사 스트림 수신 (lk.transcription) ── */
    const onTranscription = async (reader: any, pinfo: { identity: string }) => {
      const info = reader?.info || {};
      console.log('info');
      console.log(info);
      const attrs = (info.attributes || {}) as Record<string, any>;
      // const streamId: string =
      //   info.id || `seg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const streamId = info.attributes['lk.segment_id'];
      const tsMs = toMs(info.timestamp);
      const fromIdentity = pinfo.identity;
      const fromName = nameOf(room, fromIdentity);
      const role: Role = attrs['lk.transcribed_track_id'] ? 'user' : 'agent';

      // A) 번역이 먼저 왔다면 임시 버블 입양 → streamId로 승격
      const tempId = pendingBySpeaker.current.get(fromIdentity);
      let bub = getB(streamId);
      if (!bub) {
        if (tempId && getB(tempId)) {
          const tmp = getB(tempId)!;
          mapRef.current.delete(tempId);
          pendingBySpeaker.current.delete(fromIdentity);
          bub = { ...tmp, id: streamId, startedAt: Math.min(tmp.startedAt, tsMs), role };
        } else {
          bub = {
            id: streamId,
            fromIdentity,
            fromName,
            role,
            startedAt: tsMs,
            transcript: '',
            transcriptFinal: false,
            translation: '',
            translationFinal: false,
          };
        }
        upsert(bub);
      }

      // B) 화자의 열린 버블로 등록 (seg_id 없는 번역이 붙을 곳)
      openBySpeaker.current.set(fromIdentity, streamId);

      // C) 전사 델타 누적
      let acc = bub.transcript || '';
      for await (const chunk of reader) {
        const piece =
          typeof chunk === 'string'
            ? chunk
            : typeof chunk?.current === 'string'
            ? chunk.current
            : String(chunk);

        // ✅ 누적본/델타/중복 모두 안전하게 병합
        const cur = getB(streamId);
        if (!cur) continue;

        const merged = smartMerge(cur.transcript || '', piece);
        // 같은 내용이면 불필요 렌더 피하기 (옵션)
        if (merged !== cur.transcript) {
          upsert({ ...cur, transcript: merged, transcriptFinal: false });
        }
      }

      // D) 스트림 종료 → final 플래그
      const cur = getB(streamId);
      if (cur) {
        const isFinal = Boolean(attrs['lk.transcription_final'] ?? true);
        upsert({ ...cur, transcriptFinal: isFinal });
      }
    };

    room.registerTextStreamHandler('lk.transcription', onTranscription);

    return () => {
      room.off(RoomEvent.DataReceived, onData);
      room.unregisterTextStreamHandler('lk.transcription');
    };
  }, [room]);

  // 렌더 목록: Map -> array (최근 N개만)
  const items = useMemo(() => {
    return [...mapRef.current.values()].sort((a, b) => a.startedAt - b.startedAt).slice(-30);
  }, [version]);

  console.log(items);

  return (
    <div className={styles.chatWrapper}>
      <div className={styles.bubblesContainer}>
        {items.map((b) => {
          const isSelf = b.fromName === selfName && b.role === 'user';
          const sideCls = isSelf ? styles.bubbleRight : styles.bubbleLeft;
          const showTranslating =
            !b.translationFinal && !!b.transcript && b.translation.length === 0;

          return (
            <div key={b.id} className={sideCls}>
              <div className={styles.meta}>
                <span className={styles.speaker}>{b.role === 'agent' ? 'Agent' : b.fromName}</span>
                <span className={styles.time}>{new Date(b.startedAt).toLocaleTimeString()}</span>
                {!b.transcriptFinal && <span className={styles.partial}> • listening…</span>}
              </div>

              {/* 윗줄: 번역 (진행 중이면 translating...) */}
              <div className={styles.text}>
                {showTranslating ? '(translating...)' : b.translation}
              </div>

              {/* 아랫줄: 전사(원문) */}
              {b.transcript && (
                <div className={styles.original}>
                  {b.transcript}
                  {!b.transcriptFinal && <span className={styles.partial}> ▋</span>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
