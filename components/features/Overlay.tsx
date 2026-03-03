import { DataPacket_Kind, Participant, Room, RoomEvent } from 'livekit-client';
import { useEffect, useRef, useState } from 'react';

type Det = { bbox: number[]; cls: number; conf: number; track_id: number; participant: string };
type ParticipantDetState = { dets: Det[]; updatedAt: number };
type FaceLandmarkFace = { face_index: number; bbox: number[]; landmarks: number[][] };
type FaceIdentityFace = { bbox: number[]; name: string; similarity: number; live?: boolean };
type ParticipantLandmarkState = {
  faces: FaceLandmarkFace[];
  isLive: boolean;
  updatedAt: number;
};
type ParticipantIdentityState = {
  faces: FaceIdentityFace[];
  isLive: boolean;
  updatedAt: number;
};
const FACEMESH_CONTOUR_CONNECTIONS: Array<[number, number]> = [
  [0, 267], [7, 163], [10, 338], [13, 312], [14, 317], [17, 314], [21, 54], [33, 7],
  [33, 246], [37, 0], [39, 37], [40, 39], [46, 53], [52, 65], [53, 52], [54, 103],
  [58, 132], [61, 146], [61, 185], [63, 105], [65, 55], [66, 107], [67, 109], [70, 63],
  [78, 95], [78, 191], [80, 81], [81, 82], [82, 13], [84, 17], [87, 14], [88, 178],
  [91, 181], [93, 234], [95, 88], [103, 67], [105, 66], [109, 10], [127, 162], [132, 93],
  [136, 172], [144, 145], [145, 153], [146, 91], [148, 176], [149, 150], [150, 136], [152, 148],
  [153, 154], [154, 155], [155, 133], [157, 173], [158, 157], [159, 158], [160, 159], [161, 160],
  [162, 21], [163, 144], [172, 58], [173, 133], [176, 149], [178, 87], [181, 84], [185, 40],
  [191, 80], [234, 127], [246, 161], [249, 390], [251, 389], [263, 249], [263, 466], [267, 269],
  [269, 270], [270, 409], [276, 283], [282, 295], [283, 282], [284, 251], [288, 397], [293, 334],
  [295, 285], [296, 336], [297, 332], [300, 293], [310, 415], [311, 310], [312, 311], [314, 405],
  [317, 402], [318, 324], [321, 375], [323, 361], [324, 308], [332, 284], [334, 296], [338, 297],
  [356, 454], [361, 288], [365, 379], [373, 374], [374, 380], [375, 291], [377, 152], [378, 400],
  [379, 378], [380, 381], [381, 382], [382, 362], [384, 398], [385, 384], [386, 385], [387, 386],
  [388, 387], [389, 356], [390, 373], [397, 365], [398, 362], [400, 377], [402, 318], [405, 321],
  [409, 291], [415, 308], [454, 323], [466, 388],
];
const FACEMESH_IRIS_CONNECTIONS: Array<[number, number]> = [
  [469, 470], [470, 471], [471, 472], [472, 469], [474, 475], [475, 476], [476, 477], [477, 474],
];
const DET_TTL_MS = 1200;
const LANDMARK_TTL_MS = 1200;
const IDENTITY_TTL_MS = 2000;
const roomDetStateStore = new WeakMap<Room, Map<string, ParticipantDetState>>();
const roomLandmarkStateStore = new WeakMap<Room, Map<string, ParticipantLandmarkState>>();
const roomIdentityStateStore = new WeakMap<Room, Map<string, ParticipantIdentityState>>();
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

function getLandmarkState(room: Room): Map<string, ParticipantLandmarkState> {
  const existing = roomLandmarkStateStore.get(room);
  if (existing) return existing;
  const created = new Map<string, ParticipantLandmarkState>();
  roomLandmarkStateStore.set(room, created);
  return created;
}

function getIdentityState(room: Room): Map<string, ParticipantIdentityState> {
  const existing = roomIdentityStateStore.get(room);
  if (existing) return existing;
  const created = new Map<string, ParticipantIdentityState>();
  roomIdentityStateStore.set(room, created);
  return created;
}

type OverlayDebugSnapshot = {
  effectRuns: number;
  packetsTotal: number;
  packetsForMe: number;
  lastPacketAt: number | null;
  lastPacketForMeAt: number | null;
  lastDrawAt: number | null;
  lastYoloCount: number;
  lastLandmarkCount: number;
  lastIdentityCount: number;
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
  const landmarkStateRef = useRef<Map<string, ParticipantLandmarkState>>(new Map());
  const identityStateRef = useRef<Map<string, ParticipantIdentityState>>(new Map());
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
  const lastYoloCountRef = useRef(0);
  const lastLandmarkCountRef = useRef(0);
  const lastIdentityCountRef = useRef(0);
  const videoStateRef = useRef('video=none');
  const [debugSnapshot, setDebugSnapshot] = useState<OverlayDebugSnapshot>({
    effectRuns: 0,
    packetsTotal: 0,
    packetsForMe: 0,
    lastPacketAt: null,
    lastPacketForMeAt: null,
    lastDrawAt: null,
    lastYoloCount: 0,
    lastLandmarkCount: 0,
    lastIdentityCount: 0,
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
        lastYoloCount: lastYoloCountRef.current,
        lastLandmarkCount: lastLandmarkCountRef.current,
        lastIdentityCount: lastIdentityCountRef.current,
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

  function mapPoint(nx: number, ny: number, video: HTMLVideoElement, canvas: HTMLCanvasElement) {
    const { x, y } = mapBBox([nx, ny, 0, 0], video, canvas);
    return { x, y };
  }

  function drawConnections(
    ctx: CanvasRenderingContext2D,
    facePoints: number[][],
    connections: Array<[number, number]>,
    video: HTMLVideoElement,
    canvas: HTMLCanvasElement,
  ) {
    for (const [a, b] of connections) {
      const pa = facePoints[a];
      const pb = facePoints[b];
      if (!pa || !pb || pa.length < 2 || pb.length < 2) continue;
      const pax = Number(pa[0]);
      const pay = Number(pa[1]);
      const pbx = Number(pb[0]);
      const pby = Number(pb[1]);
      if (!Number.isFinite(pax) || !Number.isFinite(pay) || !Number.isFinite(pbx) || !Number.isFinite(pby)) {
        continue;
      }
      const p1 = mapPoint(pax, pay, video, canvas);
      const p2 = mapPoint(pbx, pby, video, canvas);
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
    }
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
    landmarkStateRef.current = getLandmarkState(room);
    identityStateRef.current = getIdentityState(room);

    const isDet = (value: any): value is Det =>
      !!value &&
      typeof value.participant === 'string' &&
      Array.isArray(value.bbox) &&
      value.bbox.length === 4 &&
      typeof value.cls === 'number' &&
      typeof value.conf === 'number' &&
      typeof value.track_id === 'number';

    const isLandmarkFace = (value: any): value is FaceLandmarkFace =>
      !!value &&
      typeof value.face_index === 'number' &&
      Array.isArray(value.bbox) &&
      value.bbox.length === 4 &&
      Array.isArray(value.landmarks);

    const isIdentityFace = (value: any): value is FaceIdentityFace =>
      !!value &&
      Array.isArray(value.bbox) &&
      value.bbox.length === 4 &&
      typeof value.name === 'string' &&
      typeof value.similarity === 'number';

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

    const upsertParticipantLandmarks = (
      identity: string,
      faces: FaceLandmarkFace[],
      isLive: boolean,
    ) => {
      if (!identity) return;
      landmarkStateRef.current.set(identity, { faces, isLive, updatedAt: Date.now() });
    };

    const upsertParticipantIdentity = (identity: string, faces: FaceIdentityFace[], isLive: boolean) => {
      if (!identity) return;
      identityStateRef.current.set(identity, { faces, isLive, updatedAt: Date.now() });
    };

    const topicIdentity = (baseTopic: string, value?: string): string | null => {
      if (!value) return null;
      const prefix = `${baseTopic}.`;
      if (!value.startsWith(prefix)) return null;
      return value.slice(prefix.length);
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
      const msgType = msg?.type;
      if (msgType !== 'yolo_dets' && msgType !== 'face_landmarks' && msgType !== 'face_identity') {
        return;
      }
      const now = Date.now();
      packetsTotalRef.current += 1;
      lastPacketAtRef.current = now;

      if (msgType === 'yolo_dets') {
        if (!Array.isArray(msg.dets)) return;
        const validDets: Det[] = msg.dets.filter(isDet);
        const splitIdentity = topicIdentity('yolo_dets', topic);
        if (splitIdentity) {
          if (splitIdentity === participantIdentity) {
            packetsForMeRef.current += 1;
            lastPacketForMeAtRef.current = now;
          }
          // topic이 이미 참가자를 식별하므로 participant 필드는 topic 기준으로 정규화
          upsertParticipantDets(
            splitIdentity,
            validDets.map((d) =>
              d.participant === splitIdentity ? d : { ...d, participant: splitIdentity },
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
        return;
      }

      if (msgType === 'face_landmarks') {
        if (!Array.isArray(msg.faces)) return;
        const splitIdentity = topicIdentity('face_landmarks', topic);
        const identity = splitIdentity ?? msg.participant;
        if (!identity || typeof identity !== 'string') return;
        const faces: FaceLandmarkFace[] = msg.faces.filter(isLandmarkFace);
        const isLive = !!msg.is_live;
        if (identity === participantIdentity) {
          packetsForMeRef.current += 1;
          lastPacketForMeAtRef.current = now;
        }
        upsertParticipantLandmarks(identity, faces, isLive);
        return;
      }

      if (!Array.isArray(msg.faces)) return;
      const splitIdentity = topicIdentity('face_identity', topic);
      const identity = splitIdentity ?? msg.participant;
      if (!identity || typeof identity !== 'string') return;
      const faces: FaceIdentityFace[] = msg.faces.filter(isIdentityFace);
      const isLive = !!msg.is_live;
      if (identity === participantIdentity) {
        packetsForMeRef.current += 1;
        lastPacketForMeAtRef.current = now;
      }
      upsertParticipantIdentity(identity, faces, isLive);
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
      for (const [identity, state] of landmarkStateRef.current.entries()) {
        if (now - state.updatedAt > LANDMARK_TTL_MS) {
          landmarkStateRef.current.delete(identity);
        }
      }
      for (const [identity, state] of identityStateRef.current.entries()) {
        if (now - state.updatedAt > IDENTITY_TTL_MS) {
          identityStateRef.current.delete(identity);
        }
      }

      const detState = detStateRef.current.get(participantIdentity);
      const dets = detState ? detState.dets : [];
      const landmarkState = landmarkStateRef.current.get(participantIdentity);
      const landmarkFaces = landmarkState ? landmarkState.faces : [];
      const identityState = identityStateRef.current.get(participantIdentity);
      const identityFaces = identityState ? identityState.faces : [];
      lastDrawAtRef.current = now;
      lastYoloCountRef.current = dets.length;
      lastLandmarkCountRef.current = landmarkFaces.length;
      lastIdentityCountRef.current = identityFaces.length;

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

      ctx.strokeStyle = '#40c4ff';
      ctx.lineWidth = 2;
      for (const f of identityFaces) {
        const { x, y, w, h } = mapBBox(f.bbox, vid, cvs);
        ctx.strokeRect(x, y, w, h);
        const who = f.name || 'Unknown';
        const sim = Number.isFinite(f.similarity) ? ` ${(f.similarity * 100).toFixed(1)}%` : '';
        const liveText = f.live === false ? ' no-live' : '';
        const label = `${who}${sim}${liveText}`;
        const pad = 4;
        const lh = 16;
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(x, y - lh, tw + pad * 2, lh);
        ctx.fillStyle = '#e6f7ff';
        ctx.fillText(label, x + pad, y - 4);
      }

      ctx.fillStyle = '#ffeb3b';
      for (const face of landmarkFaces) {
        if (face.landmarks.length >= 468) {
          ctx.strokeStyle = 'rgba(255, 235, 59, 0.75)';
          ctx.lineWidth = 1;
          drawConnections(ctx, face.landmarks, FACEMESH_CONTOUR_CONNECTIONS, vid, cvs);
        }
        if (face.landmarks.length >= 478) {
          ctx.strokeStyle = 'rgba(255, 87, 34, 0.95)';
          ctx.lineWidth = 1.2;
          drawConnections(ctx, face.landmarks, FACEMESH_IRIS_CONNECTIONS, vid, cvs);
        }

        ctx.fillStyle = '#ffeb3b';
        for (const point of face.landmarks) {
          if (!Array.isArray(point) || point.length < 2) continue;
          const px = Number(point[0]);
          const py = Number(point[1]);
          if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
          const { x, y } = mapPoint(px, py, vid, cvs);
          ctx.beginPath();
          ctx.arc(x, y, 1.5, 0, Math.PI * 2);
          ctx.fill();
        }
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
drawAt:${debugSnapshot.lastDrawAt ? formatTs(debugSnapshot.lastDrawAt) : '-'} yolo:${debugSnapshot.lastYoloCount} lm:${debugSnapshot.lastLandmarkCount} id:${debugSnapshot.lastIdentityCount}
${debugSnapshot.videoState}`}
        </div>
      )}
    </>
  );
}
