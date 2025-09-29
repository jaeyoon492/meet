import { Room } from 'livekit-client';
import { useEffect, useRef } from 'react';

type Det = { bbox: number[]; cls: number; conf: number; track_id: number; participant: string };

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

  function isMirrored(video: HTMLVideoElement) {
    // LiveKit는 로컬 카메라에 CSS transform: scaleX(-1) 적용
    const t = getComputedStyle(video).transform;
    return !!t && /matrix\(-1/.test(t);
  }

  // 비디오/캔버스 크기 동기화 (DPR 포함)
  const syncCanvasSize = () => {
    const cvs = canvasRef.current;
    const vid = getVideoEl();
    if (!cvs || !vid || !vid.videoWidth || !vid.videoHeight) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = cvs.getBoundingClientRect();
    // 논리 픽셀 기준 크기 설정 후 스케일 적용
    cvs.width = Math.round(rect.width * dpr);
    cvs.height = Math.round(rect.height * dpr);
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
    const cvs = canvasRef.current!;
    const ro = new ResizeObserver(syncCanvasSize);
    ro.observe(cvs.parentElement!);

    // 데이터 수신
    const handler = (payload: Uint8Array /* , participant, topic? */) => {
      const vid = getVideoEl();
      if (!vid) return;

      // 캔버스 크기 동기화
      syncCanvasSize();

      let msg: any;
      try {
        msg = JSON.parse(new TextDecoder().decode(payload));
      } catch {
        return;
      }
      if (msg?.type !== 'yolo_dets' || !Array.isArray(msg.dets)) return;

      // 이 타일의 participant만 남긴다
      const dets: Det[] = msg.dets.filter((d: Det) => d.participant === participantIdentity);

      const ctx = cvs.getContext('2d')!;
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
    };

    room.on('dataReceived', handler);
    return () => {
      room.off('dataReceived', handler as any);
      ro.disconnect();
    };
  }, [room, participantIdentity, getVideoEl]);

  return (
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
  );
}
