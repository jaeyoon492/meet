import { DataPacket_Kind, Participant, Room, RoomEvent } from 'livekit-client';
import { useEffect, useRef, useState } from 'react';

type Det = { bbox: number[]; cls: number; conf: number; track_id: number; participant: string };
type ParticipantDetState = { dets: Det[]; updatedAt: number };
const DET_TTL_MS = 1200;
const roomDetStateStore = new WeakMap<Room, Map<string, ParticipantDetState>>();
const roomOverlayMountStore = new WeakMap<Room, Map<string, number[]>>();
let overlayInstanceSeq = 0;

function formatTs(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

function getRoomState(room: Room): Map<string, ParticipantDetState> {
  const existing = roomDetStateStore.get(room);
  if (existing) return existing;
  const created = new Map<string, ParticipantDetState>();
  roomDetStateStore.set(room, created);
  return created;
}

function getOverlayMountState(room: Room): Map<string, number[]> {
  const existing = roomOverlayMountStore.get(room);
  if (existing) return existing;
  const created = new Map<string, number[]>();
  roomOverlayMountStore.set(room, created);
  return created;
}

type OverlayDebugSnapshot = {
  effectRuns: number;
  packetsTotal: number;
  packetsForMe: number;
  lastPacketAt: number | null;
  lastPacketForMeAt: number | null;
  lastDrawAt: number | null;
  lastBoxCount: number;
  videoState: string;
};

export function Overlay({
  room,
  getVideoEl,
  participantIdentity,
}: {
  room: Room;
  getVideoEl: () => HTMLVideoElement | null; // ⬅️ 함수로 받아 매 렌더에서 안전 획득
  participantIdentity: string; // ⬅️ 이 참가자만 그린다
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const detStateRef = useRef<Map<string, ParticipantDetState>>(new Map());
  const decoderRef = useRef(new TextDecoder());
  const getVideoElRef = useRef(getVideoEl);
  const instanceIdRef = useRef(0);
  const [mountHistory, setMountHistory] = useState<number[]>([]);
  const effectRunsRef = useRef(0);
  const packetsTotalRef = useRef(0);
  const packetsForMeRef = useRef(0);
  const lastPacketAtRef = useRef<number | null>(null);
  const lastPacketForMeAtRef = useRef<number | null>(null);
  const lastDrawAtRef = useRef<number | null>(null);
  const lastBoxCountRef = useRef(0);
  const videoStateRef = useRef('video=none');
  const [debugSnapshot, setDebugSnapshot] = useState<OverlayDebugSnapshot>({
    effectRuns: 0,
    packetsTotal: 0,
    packetsForMe: 0,
    lastPacketAt: null,
    lastPacketForMeAt: null,
    lastDrawAt: null,
    lastBoxCount: 0,
    videoState: 'video=none',
  });
  const isDebug = process.env.NODE_ENV !== 'production';

  if (instanceIdRef.current === 0) {
    overlayInstanceSeq += 1;
    instanceIdRef.current = overlayInstanceSeq;
  }

  useEffect(() => {
    getVideoElRef.current = getVideoEl;
  }, [getVideoEl]);

  useEffect(() => {
    const roomMountState = getOverlayMountState(room);
    const next = [...(roomMountState.get(participantIdentity) ?? []), Date.now()].slice(-5);
    roomMountState.set(participantIdentity, next);
    setMountHistory(next);
  }, [room, participantIdentity]);

  useEffect(() => {
    if (!isDebug) return;
    const id = window.setInterval(() => {
      setDebugSnapshot({
        effectRuns: effectRunsRef.current,
        packetsTotal: packetsTotalRef.current,
        packetsForMe: packetsForMeRef.current,
        lastPacketAt: lastPacketAtRef.current,
        lastPacketForMeAt: lastPacketForMeAtRef.current,
        lastDrawAt: lastDrawAtRef.current,
        lastBoxCount: lastBoxCountRef.current,
        videoState: videoStateRef.current,
      });
    }, 500);
    return () => window.clearInterval(id);
  }, [isDebug, room, participantIdentity]);

  function isMirrored(video: HTMLVideoElement) {
    // LiveKit는 로컬 카메라에 CSS transform: scaleX(-1) 적용
    const t = getComputedStyle(video).transform;
    return !!t && /matrix\(-1/.test(t);
  }

  // 비디오/캔버스 크기 동기화 (DPR 포함)
  const syncCanvasSize = () => {
    const cvs = canvasRef.current;
    if (!cvs) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = cvs.getBoundingClientRect();
    const targetW = Math.max(0, Math.round(rect.width * dpr));
    const targetH = Math.max(0, Math.round(rect.height * dpr));
    if (cvs.width === targetW && cvs.height === targetH) return;
    // 논리 픽셀 기준 크기 설정 후 스케일 적용
    cvs.width = targetW;
    cvs.height = targetH;
    const ctx = cvs.getContext('2d');
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  // object-fit: contain 레터박스 보정
  function mapBBox(bbox: number[], video: HTMLVideoElement, canvas: HTMLCanvasElement) {
    const vw = video.videoWidth,
      vh = video.videoHeight;
    const cw = canvas.clientWidth,
      ch = canvas.clientHeight;

    // object-fit 판별
    const fit = (getComputedStyle(video).objectFit || 'contain').toLowerCase();

    let drawW: number, drawH: number, offX: number, offY: number;
    if (fit === 'cover') {
      const s = Math.max(cw / vw, ch / vh);
      drawW = vw * s;
      drawH = vh * s;
      offX = (cw - drawW) / 2;
      offY = (ch - drawH) / 2;
    } else {
      // contain / fill / none → contain처럼 처리
      const s = Math.min(cw / vw, ch / vh);
      drawW = vw * s;
      drawH = vh * s;
      offX = (cw - drawW) / 2;
      offY = (ch - drawH) / 2;
    }

    // 정규화(0~1) → 화면 좌표
    let [nx, ny, nw, nh] = bbox;

    // 미러링 보정: x를 좌우 뒤집기
    if (isMirrored(video)) {
      nx = 1 - nx - nw;
    }

    const x = offX + nx * drawW;
    const y = offY + ny * drawH;
    const w = nw * drawW;
    const h = nh * drawH;
    return { x, y, w, h };
  }

  useEffect(() => {
    effectRunsRef.current += 1;
    const cvs = canvasRef.current;
    if (!cvs) return;

    const ro = new ResizeObserver(syncCanvasSize);
    if (cvs.parentElement) {
      ro.observe(cvs.parentElement);
    }
    syncCanvasSize();
    detStateRef.current = getRoomState(room);

    const isDet = (value: any): value is Det =>
      !!value &&
      typeof value.participant === 'string' &&
      Array.isArray(value.bbox) &&
      value.bbox.length === 4 &&
      typeof value.cls === 'number' &&
      typeof value.conf === 'number' &&
      typeof value.track_id === 'number';

    const upsertParticipantDets = (identity: string, dets: Det[]) => {
      if (!identity) return;
      const prev = detStateRef.current.get(identity);
      // Rerender/track switch 직후 빈 패킷이 들어와도 최근 박스를 잠시 유지해 깜빡임 완화
      if (
        dets.length === 0 &&
        prev &&
        prev.dets.length > 0 &&
        Date.now() - prev.updatedAt < DET_TTL_MS
      ) {
        return;
      }
      detStateRef.current.set(identity, { dets, updatedAt: Date.now() });
    };

    const onData = (
      payload: Uint8Array,
      _participant?: Participant,
      _kind?: DataPacket_Kind,
      topic?: string,
    ) => {
      let msg: any;
      try {
        msg = JSON.parse(decoderRef.current.decode(payload));
      } catch {
        return;
      }
      if (msg?.type !== 'yolo_dets' || !Array.isArray(msg.dets)) return;
      const now = Date.now();
      packetsTotalRef.current += 1;
      lastPacketAtRef.current = now;

      const validDets: Det[] = msg.dets.filter(isDet);
      if (topic?.startsWith('yolo_dets.')) {
        const topicIdentity = topic.slice('yolo_dets.'.length);
        if (topicIdentity === participantIdentity) {
          packetsForMeRef.current += 1;
          lastPacketForMeAtRef.current = now;
        }
        // topic이 이미 참가자를 식별하므로 participant 필드는 topic 기준으로 정규화
        upsertParticipantDets(
          topicIdentity,
          validDets.map((d) =>
            d.participant === topicIdentity ? d : { ...d, participant: topicIdentity },
          ),
        );
        return;
      }

      const grouped = new Map<string, Det[]>();
      for (const d of validDets) {
        const arr = grouped.get(d.participant) ?? [];
        arr.push(d);
        grouped.set(d.participant, arr);
      }
      if (grouped.has(participantIdentity)) {
        packetsForMeRef.current += 1;
        lastPacketForMeAtRef.current = now;
      }
      grouped.forEach((dets, identity) => upsertParticipantDets(identity, dets));
    };

    room.on(RoomEvent.DataReceived, onData);

    let rafId = 0;
    const render = () => {
      syncCanvasSize();
      const vid = getVideoElRef.current();
      const ctx = cvs.getContext('2d');
      if (!vid || !ctx) {
        videoStateRef.current = 'video=none';
        rafId = requestAnimationFrame(render);
        return;
      }
      if (!vid.videoWidth || !vid.videoHeight) {
        videoStateRef.current = `video=waiting rs=${vid.readyState} v=${vid.videoWidth}x${vid.videoHeight}`;
        rafId = requestAnimationFrame(render);
        return;
      }
      videoStateRef.current = `video=ready rs=${vid.readyState} v=${vid.videoWidth}x${vid.videoHeight} c=${vid.clientWidth}x${vid.clientHeight}`;

      const now = Date.now();
      for (const [identity, state] of detStateRef.current.entries()) {
        if (now - state.updatedAt > DET_TTL_MS) {
          detStateRef.current.delete(identity);
        }
      }

      const state = detStateRef.current.get(participantIdentity);
      const dets = state ? state.dets : [];
      lastDrawAtRef.current = now;
      lastBoxCountRef.current = dets.length;

      ctx.clearRect(0, 0, cvs.clientWidth, cvs.clientHeight);
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'lime';
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.font = '12px sans-serif';

      for (const d of dets) {
        const { x, y, w, h } = mapBBox(d.bbox, vid, cvs);

        ctx.strokeRect(x, y, w, h);
        const label = `${d.cls} #${d.track_id} ${(d.conf * 100).toFixed(1)}%`;
        const pad = 4,
          lh = 16,
          tw = ctx.measureText(label).width;
        ctx.fillRect(x, y - lh, tw + pad * 2, lh);
        ctx.fillStyle = '#fff';
        ctx.fillText(label, x + pad, y - 4);
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
      }

      rafId = requestAnimationFrame(render);
    };
    rafId = requestAnimationFrame(render);

    return () => {
      room.off(RoomEvent.DataReceived, onData);
      cancelAnimationFrame(rafId);
      ro.disconnect();
    };
  }, [room, participantIdentity]);

  const mountCount = mountHistory.length;
  const latestMount = mountHistory[mountHistory.length - 1];

  return (
    <>
      <canvas
        ref={canvasRef}
        style={{
          position: 'absolute',
          width: '100%',
          height: '100%',
          inset: 0,
          pointerEvents: 'none', // 클릭 방해 금지
        }}
      />
      {isDebug && (
        <div
          style={{
            position: 'absolute',
            top: 6,
            right: 6,
            zIndex: 10,
            pointerEvents: 'none',
            fontFamily: 'monospace',
            fontSize: 11,
            lineHeight: 1.35,
            color: '#9ef08e',
            background: 'rgba(0,0,0,0.55)',
            border: '1px solid rgba(158,240,142,0.65)',
            borderRadius: 6,
            padding: '4px 6px',
            whiteSpace: 'pre-line',
          }}
        >
          {`Overlay#${instanceIdRef.current}
mounts:${mountCount}
last:${latestMount ? formatTs(latestMount) : '-'}
history:${mountHistory.map(formatTs).join(' | ') || '-'}
effectRuns:${debugSnapshot.effectRuns}
pkts:${debugSnapshot.packetsTotal} mine:${debugSnapshot.packetsForMe}
pktAt:${debugSnapshot.lastPacketAt ? formatTs(debugSnapshot.lastPacketAt) : '-'}
mineAt:${debugSnapshot.lastPacketForMeAt ? formatTs(debugSnapshot.lastPacketForMeAt) : '-'}
drawAt:${debugSnapshot.lastDrawAt ? formatTs(debugSnapshot.lastDrawAt) : '-'} boxes:${debugSnapshot.lastBoxCount}
${debugSnapshot.videoState}`}
        </div>
      )}
    </>
  );
}
