'use client';

import { generateRoomId, randomString } from '@/lib/client-utils';
import type { ConnectionDetails } from '@/lib/types';
import { useRouter, useSearchParams } from 'next/navigation';
import React from 'react';
import {
  DataPacket_Kind,
  LocalVideoTrack,
  Participant,
  Room,
  RoomConnectOptions,
  RoomEvent,
  Track,
  VideoPresets,
  createLocalVideoTrack,
} from 'livekit-client';

const CONN_DETAILS_ENDPOINT =
  process.env.NEXT_PUBLIC_CONN_DETAILS_ENDPOINT ?? '/api/connection-details';
const FACE_ENROLL_TOPIC = process.env.NEXT_PUBLIC_FACE_ENROLL_TOPIC ?? 'face_enroll';
const FACE_ENROLL_RESULT_TOPIC =
  process.env.NEXT_PUBLIC_FACE_ENROLL_RESULT_TOPIC ?? 'face_enroll_result';
const FACE_LANDMARK_TOPIC = process.env.NEXT_PUBLIC_FACE_LANDMARK_TOPIC ?? 'face_landmarks';
const ENROLL_TICK_MS = 400;
const POSE_HOLD_MS = 1200;
const ENROLL_RESULT_TIMEOUT_MS = 2500;
const ROOM_NAME_PATTERN = /^[a-z0-9-]{4,64}$/;
const REQUIRED_POSES = ['center', 'left', 'right'] as const;
type RequiredPose = (typeof REQUIRED_POSES)[number];

type EnrollResultPayload = {
  type?: string;
  participant?: string;
  ok?: boolean;
  reason?: string;
  name?: string;
  count?: number;
};

type FaceLandmarkFace = {
  bbox?: number[];
  landmarks?: number[][];
};

type FaceLandmarkPayload = {
  type?: string;
  participant?: string;
  faces?: FaceLandmarkFace[];
};

type EnrollStats = {
  sent: number;
  ok: number;
  duplicate: number;
  failed: number;
};

type EnrollPose = 'center' | 'left' | 'right' | 'unknown';

const DEFAULT_STATS: EnrollStats = {
  sent: 0,
  ok: 0,
  duplicate: 0,
  failed: 0,
};

function isEnrollResultTopic(topic: string | undefined, identity: string) {
  if (!topic) return true;
  return topic === FACE_ENROLL_RESULT_TOPIC || topic === `${FACE_ENROLL_RESULT_TOPIC}.${identity}`;
}

function isFaceLandmarkPayload(payload: unknown): payload is FaceLandmarkPayload {
  if (!payload || typeof payload !== 'object') return false;
  const candidate = payload as { type?: unknown };
  return candidate.type === 'face_landmarks';
}

function isEnrollResultPayload(payload: unknown): payload is EnrollResultPayload {
  if (!payload || typeof payload !== 'object') return false;
  const candidate = payload as { type?: unknown; ok?: unknown; reason?: unknown };
  if (candidate.type === 'face_enroll_result') return true;
  return typeof candidate.ok === 'boolean' || typeof candidate.reason === 'string';
}

function topicIdentity(baseTopic: string, topic?: string): string | null {
  if (!topic) return null;
  const prefix = `${baseTopic}.`;
  if (!topic.startsWith(prefix)) return null;
  return topic.slice(prefix.length);
}

function poseLabel(pose: EnrollPose): string {
  if (pose === 'center') return '정면';
  if (pose === 'left') return '왼쪽';
  if (pose === 'right') return '오른쪽';
  return '미확인';
}

function inferPose(face?: FaceLandmarkFace): EnrollPose {
  if (!face?.landmarks || face.landmarks.length < 264) return 'unknown';
  const nose = face.landmarks[1];
  const leftEye = face.landmarks[33];
  const rightEye = face.landmarks[263];
  if (!nose || !leftEye || !rightEye) return 'unknown';
  if (nose.length < 2 || leftEye.length < 2 || rightEye.length < 2) return 'unknown';

  const eyeDist = Math.abs(Number(rightEye[0]) - Number(leftEye[0]));
  if (!Number.isFinite(eyeDist) || eyeDist < 0.01) return 'unknown';
  const eyeMid = (Number(leftEye[0]) + Number(rightEye[0])) * 0.5;
  const offset = (Number(nose[0]) - eyeMid) / eyeDist;
  if (!Number.isFinite(offset)) return 'unknown';
  if (offset <= -0.08) return 'left';
  if (offset >= 0.08) return 'right';
  return 'center';
}

function normalizeRoomName(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  return ROOM_NAME_PATTERN.test(trimmed) ? trimmed : null;
}

function nextRequiredPose(capturedPoses: Set<RequiredPose>): RequiredPose | null {
  return REQUIRED_POSES.find((pose) => !capturedPoses.has(pose)) ?? null;
}

function captureProgress(capturedPoses: Set<RequiredPose>): number {
  return Math.round((capturedPoses.size / REQUIRED_POSES.length) * 100);
}

function remainingSecondsText(ms: number): string {
  return (Math.max(ms, 0) / 1000).toFixed(1);
}

function holdProgressPercent(heldMs: number): number {
  if (!Number.isFinite(heldMs) || heldMs <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((heldMs / POSE_HOLD_MS) * 100)));
}

function holdElapsedText(heldMs: number): string {
  const clamped = Math.max(0, Math.min(heldMs, POSE_HOLD_MS));
  return `${(clamped / 1000).toFixed(1)} / ${(POSE_HOLD_MS / 1000).toFixed(1)}초`;
}

function faceSessionStorageKey(roomName: string): string {
  return `faceSessionId:${roomName}`;
}

function EnrollPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const e2eeParam = searchParams.get('e2ee');
  const callRoomFromQuery = normalizeRoomName(searchParams.get('room'));
  const callRoomNameRef = React.useRef(callRoomFromQuery ?? generateRoomId());
  const faceSessionIdRef = React.useRef(`face-sess-${randomString(12)}`);
  const enrollRoomNameRef = React.useRef(
    `${callRoomNameRef.current}-enroll-${randomString(6)}`,
  );
  const callRoomName = callRoomNameRef.current;
  const faceSessionId = faceSessionIdRef.current;
  const enrollRoomName = enrollRoomNameRef.current;

  const [displayName, setDisplayName] = React.useState('홍길동');
  const [participantName, setParticipantName] = React.useState('');
  const [participantIdentity, setParticipantIdentity] = React.useState('');
  const [connectionState, setConnectionState] = React.useState<
    'idle' | 'connecting' | 'connected' | 'error'
  >('idle');
  const [statusText, setStatusText] = React.useState('카메라 연결 준비 중');
  const [errorText, setErrorText] = React.useState('');
  const [guideText, setGuideText] = React.useState('가이드 준비 중');
  const [isRunning, setIsRunning] = React.useState(false);
  const [progress, setProgress] = React.useState(0);
  const [holdProgress, setHoldProgress] = React.useState(0);
  const [holdText, setHoldText] = React.useState(`0.0 / ${(POSE_HOLD_MS / 1000).toFixed(1)}초`);
  const [stats, setStats] = React.useState<EnrollStats>(DEFAULT_STATS);
  const [lastResultText, setLastResultText] = React.useState('');

  const videoElRef = React.useRef<HTMLVideoElement | null>(null);
  const roomRef = React.useRef<Room | null>(null);
  const videoTrackRef = React.useRef<LocalVideoTrack | null>(null);
  const identityRef = React.useRef('');
  const faceVisibleRef = React.useRef(false);
  const faceCenteredRef = React.useRef(false);
  const faceSizeOkRef = React.useRef(false);
  const poseRef = React.useRef<EnrollPose>('unknown');
  const landmarkReadyRef = React.useRef(false);
  const capturedPosesRef = React.useRef<Set<RequiredPose>>(new Set());
  const pendingPoseRef = React.useRef<RequiredPose | null>(null);
  const pendingSinceRef = React.useRef(0);
  const poseHoldPoseRef = React.useRef<RequiredPose | null>(null);
  const poseHoldSinceRef = React.useRef<number>(0);
  const isRunningRef = React.useRef(false);
  const sendTimerRef = React.useRef<ReturnType<typeof setInterval> | null>(null);

  const cleanupTimers = React.useCallback(() => {
    if (sendTimerRef.current) {
      clearInterval(sendTimerRef.current);
      sendTimerRef.current = null;
    }
  }, []);

  const finishEnrollment = React.useCallback(
    (statusMessage: string) => {
      cleanupTimers();
      pendingPoseRef.current = null;
      pendingSinceRef.current = 0;
      poseHoldPoseRef.current = null;
      poseHoldSinceRef.current = 0;
      isRunningRef.current = false;
      setIsRunning(false);
      setProgress(100);
      setHoldProgress(100);
      setHoldText(holdElapsedText(POSE_HOLD_MS));
      setGuideText('필수 방향 샘플 수집 완료.');
      setStatusText(statusMessage);
    },
    [cleanupTimers],
  );

  const disconnectRoom = React.useCallback(async () => {
    cleanupTimers();
    isRunningRef.current = false;
    pendingPoseRef.current = null;
    pendingSinceRef.current = 0;
    poseHoldPoseRef.current = null;
    poseHoldSinceRef.current = 0;
    setHoldProgress(0);
    setHoldText(`0.0 / ${(POSE_HOLD_MS / 1000).toFixed(1)}초`);
    if (videoTrackRef.current) {
      videoTrackRef.current.detach();
      videoTrackRef.current.stop();
      videoTrackRef.current = null;
    }
    if (roomRef.current) {
      try {
        await roomRef.current.disconnect();
      } catch {
        // ignore
      } finally {
        roomRef.current = null;
      }
    }
  }, [cleanupTimers]);

  React.useEffect(() => {
    let cancelled = false;

    const connect = async () => {
      try {
        setConnectionState('connecting');
        setStatusText('LiveKit 연결 중');
        setErrorText('');

        const generatedParticipantName = `등록자${randomString(4)}`;
        setParticipantName(generatedParticipantName);

        const metadata = JSON.stringify({
          preferred_language: 'ko',
          face_session_id: faceSessionId,
          face_phase: 'enroll',
        });
        const url = new URL(CONN_DETAILS_ENDPOINT, window.location.origin);
        url.searchParams.append('roomName', enrollRoomName);
        url.searchParams.append('participantName', generatedParticipantName);
        url.searchParams.append('metadata', metadata);

        const connectionResp = await fetch(url.toString());
        if (!connectionResp.ok) {
          throw new Error(`Failed to fetch connection details (${connectionResp.status})`);
        }
        const details = (await connectionResp.json()) as ConnectionDetails;
        if (cancelled) return;

        const room = new Room({
          adaptiveStream: false,
          dynacast: false,
        });
        roomRef.current = room;

        const onData = (
          payload: Uint8Array,
          _participant?: Participant,
          _kind?: DataPacket_Kind,
          topic?: string,
        ) => {
          let msg: unknown;
          try {
            msg = JSON.parse(new TextDecoder().decode(payload));
          } catch {
            return;
          }
          const identity = identityRef.current;
          if (!identity) return;

          if (isFaceLandmarkPayload(msg)) {
            const splitIdentity = topicIdentity(FACE_LANDMARK_TOPIC, topic);
            const owner = splitIdentity ?? msg.participant;
            if (owner !== identity) return;

            landmarkReadyRef.current = true;
            const faces = Array.isArray(msg.faces) ? msg.faces : [];
            if (faces.length === 0) {
              faceVisibleRef.current = false;
              faceCenteredRef.current = false;
              faceSizeOkRef.current = false;
              poseRef.current = 'unknown';
              setGuideText('얼굴을 화면 중앙에 맞춰주세요.');
              return;
            }

            const face = faces[0];
            const bbox = Array.isArray(face.bbox) && face.bbox.length >= 4 ? face.bbox : [0, 0, 0, 0];
            const bx = Number(bbox[0]) || 0;
            const by = Number(bbox[1]) || 0;
            const bw = Number(bbox[2]) || 0;
            const bh = Number(bbox[3]) || 0;
            const cx = bx + bw * 0.5;
            const cy = by + bh * 0.5;
            const area = bw * bh;

            faceVisibleRef.current = true;
            faceCenteredRef.current = Math.abs(cx - 0.5) <= 0.18 && Math.abs(cy - 0.5) <= 0.22;
            faceSizeOkRef.current = area >= 0.08;
            poseRef.current = inferPose(face);

            if (!isRunningRef.current) {
              setHoldProgress(0);
              setHoldText(`0.0 / ${(POSE_HOLD_MS / 1000).toFixed(1)}초`);
              if (!faceSizeOkRef.current) {
                setGuideText('얼굴을 조금 더 가까이 비춰주세요.');
              } else if (!faceCenteredRef.current) {
                setGuideText('얼굴을 화면 중앙으로 맞춰주세요.');
              } else {
                setGuideText(`현재 방향: ${poseLabel(poseRef.current)}`);
              }
            }
            return;
          }

          if (!isEnrollResultPayload(msg)) return;
          if (!isEnrollResultTopic(topic, identity)) return;
          if (msg.participant && msg.participant !== identity) return;

          setStats((prev) => {
            if (msg.ok) {
              return { ...prev, ok: prev.ok + 1 };
            }
            if (msg.reason === 'duplicate') {
              return { ...prev, duplicate: prev.duplicate + 1 };
            }
            return { ...prev, failed: prev.failed + 1 };
          });

          if (msg.ok) {
            setLastResultText(`등록 성공: ${msg.name} (누적 샘플 ${msg.count ?? '-'})`);
          } else {
            setLastResultText(`등록 실패: ${msg.reason ?? 'unknown'}`);
          }

          if (!isRunningRef.current) return;
          const pendingPose = pendingPoseRef.current;
          if (!pendingPose) return;

          pendingPoseRef.current = null;
          pendingSinceRef.current = 0;
          if (msg.ok) {
            capturedPosesRef.current.add(pendingPose);
            setProgress(captureProgress(capturedPosesRef.current));
            const remaining = nextRequiredPose(capturedPosesRef.current);
            if (remaining) {
              setGuideText(`${poseLabel(pendingPose)} 샘플 등록됨. 다음: ${poseLabel(remaining)}`);
              setHoldProgress(0);
              setHoldText(`0.0 / ${(POSE_HOLD_MS / 1000).toFixed(1)}초`);
            } else {
              finishEnrollment('정면/좌/우 샘플 등록 완료. 통화를 시작하세요.');
            }
            return;
          }

          if (msg.reason === 'duplicate') {
            setGuideText(`${poseLabel(pendingPose)} 방향에서 중복 샘플입니다. 각도를 더 크게 바꿔주세요.`);
            setHoldProgress(0);
            setHoldText(`0.0 / ${(POSE_HOLD_MS / 1000).toFixed(1)}초`);
          } else {
            setGuideText(`${poseLabel(pendingPose)} 샘플 전송 실패. 자세를 유지하고 재시도합니다.`);
            setHoldProgress(0);
            setHoldText(`0.0 / ${(POSE_HOLD_MS / 1000).toFixed(1)}초`);
          }
        };

        room.on(RoomEvent.DataReceived, onData);

        const connectOptions: RoomConnectOptions = {
          autoSubscribe: false,
        };
        await room.connect(details.serverUrl, details.participantToken, connectOptions);
        if (cancelled) return;

        const identity = room.localParticipant.identity;
        identityRef.current = identity;
        setParticipantIdentity(identity);

        const localVideoTrack = await createLocalVideoTrack({
          resolution: VideoPresets.h720.resolution,
        });
        if (cancelled) {
          localVideoTrack.stop();
          return;
        }

        videoTrackRef.current = localVideoTrack;
        await room.localParticipant.publishTrack(localVideoTrack, {
          source: Track.Source.Camera,
        });
        if (videoElRef.current) {
          localVideoTrack.attach(videoElRef.current);
        }

        setConnectionState('connected');
        setStatusText('준비 완료. 얼굴을 천천히 좌/우로 움직이며 등록 시작을 눌러주세요.');
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        setConnectionState('error');
        setErrorText(message);
        setStatusText('등록 페이지 준비 실패');
        disconnectRoom().catch(() => undefined);
      }
    };

    connect();
    return () => {
      cancelled = true;
      disconnectRoom().catch(() => undefined);
    };
  }, [disconnectRoom, enrollRoomName, faceSessionId, finishEnrollment]);

  const startEnrollment = React.useCallback(() => {
    const room = roomRef.current;
    const identity = identityRef.current;
    const enrollName = displayName.trim();
    if (!room || !identity) {
      setErrorText('LiveKit 연결이 아직 준비되지 않았습니다.');
      return;
    }
    if (!enrollName) {
      setErrorText('등록 이름을 입력해주세요.');
      return;
    }
    if (isRunningRef.current) return;

    cleanupTimers();
    setStats({ ...DEFAULT_STATS });
    setLastResultText('');
    setErrorText('');
    capturedPosesRef.current = new Set();
    pendingPoseRef.current = null;
    pendingSinceRef.current = 0;
    poseHoldPoseRef.current = null;
    poseHoldSinceRef.current = 0;
    setStatusText('샘플 수집 중: 정면 → 왼쪽 → 오른쪽 순서, 각 방향 1.2초 유지');
    setGuideText('정면을 봐주세요. 1.2초 유지하면 샘플을 저장합니다.');
    setHoldProgress(0);
    setHoldText(`0.0 / ${(POSE_HOLD_MS / 1000).toFixed(1)}초`);
    isRunningRef.current = true;
    setIsRunning(true);
    setProgress(0);

    const sendRequest = async () => {
      if (!isRunningRef.current) return;

      const poseGuideEnabled = landmarkReadyRef.current;
      const nextPose = nextRequiredPose(capturedPosesRef.current);
      if (!nextPose) {
        finishEnrollment('정면/좌/우 샘플 등록 완료. 통화를 시작하세요.');
        return;
      }

      if (pendingPoseRef.current) {
        const pendingForMs = Date.now() - pendingSinceRef.current;
        if (pendingForMs >= ENROLL_RESULT_TIMEOUT_MS) {
          const timedOutPose = pendingPoseRef.current;
          pendingPoseRef.current = null;
          pendingSinceRef.current = 0;
          setGuideText(
            `${poseLabel(timedOutPose)} 샘플 응답이 지연되어 재시도합니다. 자세를 유지해주세요.`,
          );
          return;
        }
        setHoldProgress(100);
        setHoldText(holdElapsedText(POSE_HOLD_MS));
        setGuideText(
          `${poseLabel(pendingPoseRef.current)} 샘플 처리 중... (${(pendingForMs / 1000).toFixed(1)}초)`,
        );
        return;
      }

      if (poseGuideEnabled) {
        if (!faceVisibleRef.current) {
          poseHoldPoseRef.current = null;
          poseHoldSinceRef.current = 0;
          setHoldProgress(0);
          setHoldText(`0.0 / ${(POSE_HOLD_MS / 1000).toFixed(1)}초`);
          setGuideText('얼굴을 화면 중앙에 맞춰주세요.');
          return;
        }
        if (!faceSizeOkRef.current) {
          poseHoldPoseRef.current = null;
          poseHoldSinceRef.current = 0;
          setHoldProgress(0);
          setHoldText(`0.0 / ${(POSE_HOLD_MS / 1000).toFixed(1)}초`);
          setGuideText('얼굴을 조금 더 가까이 비춰주세요.');
          return;
        }
        if (nextPose === 'center' && !faceCenteredRef.current) {
          poseHoldPoseRef.current = null;
          poseHoldSinceRef.current = 0;
          setHoldProgress(0);
          setHoldText(`0.0 / ${(POSE_HOLD_MS / 1000).toFixed(1)}초`);
          setGuideText('정면에서 얼굴을 중앙으로 맞춰주세요.');
          return;
        }
        if (poseRef.current !== nextPose) {
          poseHoldPoseRef.current = null;
          poseHoldSinceRef.current = 0;
          setHoldProgress(0);
          setHoldText(`0.0 / ${(POSE_HOLD_MS / 1000).toFixed(1)}초`);
          setGuideText(`${poseLabel(nextPose)}을 봐주세요. (현재: ${poseLabel(poseRef.current)})`);
          return;
        }

        const now = Date.now();
        if (poseHoldPoseRef.current !== nextPose) {
          poseHoldPoseRef.current = nextPose;
          poseHoldSinceRef.current = now;
          setHoldProgress(0);
          setHoldText(holdElapsedText(0));
          setGuideText(`${poseLabel(nextPose)} 자세를 ${remainingSecondsText(POSE_HOLD_MS)}초 유지해주세요.`);
          return;
        }
        const heldMs = now - poseHoldSinceRef.current;
        if (heldMs < POSE_HOLD_MS) {
          const remainMs = POSE_HOLD_MS - heldMs;
          setHoldProgress(holdProgressPercent(heldMs));
          setHoldText(holdElapsedText(heldMs));
          setGuideText(`${poseLabel(nextPose)} 자세를 ${remainingSecondsText(remainMs)}초 더 유지해주세요.`);
          return;
        }
        setHoldProgress(100);
        setHoldText(holdElapsedText(POSE_HOLD_MS));
      }

      const payload = {
        type: 'face_enroll_request',
        name: enrollName,
        target_identity: identity,
        requested_pose: nextPose,
      };
      try {
        await room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify(payload)), {
          reliable: true,
          topic: FACE_ENROLL_TOPIC,
        });
        setStats((prev) => ({ ...prev, sent: prev.sent + 1 }));
        pendingPoseRef.current = nextPose;
        pendingSinceRef.current = Date.now();
        poseHoldPoseRef.current = null;
        poseHoldSinceRef.current = 0;
        setGuideText(`${poseLabel(nextPose)} 샘플 전송됨. 결과 확인 중...`);
      } catch {
        setStats((prev) => ({ ...prev, failed: prev.failed + 1 }));
        pendingPoseRef.current = null;
        pendingSinceRef.current = 0;
      }
    };

    sendRequest().catch(() => undefined);
    sendTimerRef.current = setInterval(() => {
      sendRequest().catch(() => undefined);
    }, ENROLL_TICK_MS);
  }, [cleanupTimers, displayName, finishEnrollment]);

  const goToRoom = React.useCallback(async () => {
    await disconnectRoom();
    const query = new URLSearchParams();
    if (participantName) {
      query.set('participantName', participantName);
    }
    if (typeof window !== 'undefined') {
      window.sessionStorage.setItem(faceSessionStorageKey(callRoomName), faceSessionId);
    }
    const queryString = query.toString();
    const roomPath = queryString
      ? `/rooms/${callRoomName}?${queryString}`
      : `/rooms/${callRoomName}`;
    const next = e2eeParam ? `${roomPath}#${e2eeParam}` : roomPath;
    router.push(next);
  }, [callRoomName, disconnectRoom, e2eeParam, faceSessionId, participantName, router]);

  const canStartEnroll = connectionState === 'connected' && !isRunning;

  return (
    <main className="min-h-dvh w-full bg-black text-white px-5 py-6 md:px-10 md:py-8">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <p className="text-sm text-zinc-400">통화 전 얼굴 등록</p>
          <h1 className="text-2xl font-semibold">다각도 얼굴 샘플 등록</h1>
          <p className="text-sm text-zinc-300">
            정면-좌-우 3개 방향 샘플이 모두 저장될 때까지 진행되며, 각 방향은 1.2초 유지해야 합니다.
          </p>
        </header>

        <section className="grid gap-5 md:grid-cols-[1.3fr_1fr]">
          <div className="rounded-xl border border-zinc-700 bg-zinc-900 p-3">
            <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-zinc-950">
              <video
                ref={videoElRef}
                autoPlay
                muted
                playsInline
                className="h-full w-full object-cover"
              />
              <div className="absolute left-3 top-3 rounded bg-black/65 px-2 py-1 text-xs">
                {connectionState === 'connected' ? 'camera: ready' : `camera: ${connectionState}`}
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-zinc-700 bg-zinc-900 p-4">
            <div className="mb-4 flex flex-col gap-2">
              <label className="text-sm text-zinc-300" htmlFor="enroll-name">
                등록 이름
              </label>
              <input
                id="enroll-name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="rounded-md border border-zinc-600 bg-zinc-800 px-3 py-2 text-sm outline-none focus:border-zinc-400"
                placeholder="예: 홍길동"
              />
            </div>

            <div className="space-y-1 text-xs text-zinc-300">
              <p>enroll_room: {enrollRoomName}</p>
              <p>call_room: {callRoomName}</p>
              <p>face_session_id: {faceSessionId}</p>
              <p>participant_name: {participantName || '-'}</p>
              <p>participant_identity: {participantIdentity || '-'}</p>
            </div>

            <div className="mt-4 h-2 w-full overflow-hidden rounded bg-zinc-800">
              <div
                className="h-full bg-emerald-500 transition-all"
                style={{ width: `${progress}%` }}
              />
            </div>
            <div className="mt-2 h-2 w-full overflow-hidden rounded bg-zinc-800">
              <div
                className="h-full bg-sky-500 transition-all"
                style={{ width: `${holdProgress}%` }}
              />
            </div>
            <p className="mt-1 text-[11px] text-sky-300">자세 유지 게이지: {holdText}</p>

            <div className="mt-4 grid grid-cols-2 gap-2 text-xs">
              <div className="rounded bg-zinc-800 px-2 py-2">sent: {stats.sent}</div>
              <div className="rounded bg-zinc-800 px-2 py-2">ok: {stats.ok}</div>
              <div className="rounded bg-zinc-800 px-2 py-2">duplicate: {stats.duplicate}</div>
              <div className="rounded bg-zinc-800 px-2 py-2">failed: {stats.failed}</div>
            </div>

            <p className="mt-4 text-xs text-zinc-200">{statusText}</p>
            <p className="mt-1 text-xs text-sky-300">{guideText}</p>
            {lastResultText ? <p className="mt-1 text-xs text-emerald-300">{lastResultText}</p> : null}
            {errorText ? <p className="mt-1 text-xs text-rose-300">{errorText}</p> : null}

            <div className="mt-5 flex gap-2">
              <button
                type="button"
                onClick={startEnrollment}
                disabled={!canStartEnroll}
                className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-45"
              >
                {isRunning ? '등록 진행 중' : '등록 시작'}
              </button>
              <button
                type="button"
                onClick={() => {
                  goToRoom().catch((err) => {
                    const message = err instanceof Error ? err.message : String(err);
                    setErrorText(message);
                  });
                }}
                className="rounded-md bg-zinc-700 px-4 py-2 text-sm font-medium text-white"
              >
                통화 시작
              </button>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

export default function EnrollPage() {
  return (
    <React.Suspense
      fallback={
        <main className="min-h-dvh w-full bg-black text-white px-5 py-6 md:px-10 md:py-8">
          <div className="mx-auto w-full max-w-5xl">
            <p className="text-sm text-zinc-300">등록 페이지 준비 중...</p>
          </div>
        </main>
      }
    >
      <EnrollPageContent />
    </React.Suspense>
  );
}
