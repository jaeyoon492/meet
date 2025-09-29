'use client';

import { decodePassphrase, randomString } from '@/lib/client-utils';
import { RecordingIndicator } from '@/components/features/RecordingIndicator';
import { ConnectionDetails } from '@/lib/types';
import {
  LiveKitRoom,
  LocalUserChoices,
  RoomAudioRenderer,
  useTracks,
  LayoutContextProvider,
  CarouselLayout,
  TrackLoop,
  isTrackReference,
  FocusLayoutContainer,
  FocusLayout,
  usePinnedTracks,
  useMediaDeviceSelect,
} from '@livekit/components-react';
import {
  ExternalE2EEKeyProvider,
  RoomOptions,
  VideoCodec,
  VideoPresets,
  Room,
  DeviceUnsupportedError,
  RoomConnectOptions,
  Track,
  RemoteTrackPublication,
  RemoteParticipant,
  LogLevel,
} from 'livekit-client';
import { useRouter } from 'next/navigation';
import React, { useCallback, useEffect, useState } from 'react';
import type { WidgetState, TrackReferenceOrPlaceholder } from '@livekit/components-core';
import { CustomParticipantTile } from '@/components/features/CustomParticipantTile';
import { QRCodeDisplay } from '@/components/features/QRCodeDisplay';
import { DebugMode } from '@/components/features/Debug';
import { Overlay } from '@/components/features/Overlay';
import TranslationRealtime from '@/components/features/TranslationRealtime';
import { CustomControlBar } from '@/components/features/CustomControlBar';
import { LanguageBottomDrawer } from '@/components/features/Language';

const CONN_DETAILS_ENDPOINT =
  process.env.NEXT_PUBLIC_CONN_DETAILS_ENDPOINT ?? '/api/connection-details';

export function PageClientImpl(props: {
  roomName: string;
  region?: string;
  hq: boolean;
  codec: VideoCodec;
}) {
  const [preJoinChoices, setPreJoinChoices] = React.useState<LocalUserChoices | undefined>(
    undefined,
  );
  const [connectionDetails, setConnectionDetails] = React.useState<ConnectionDetails | undefined>(
    undefined,
  );
  const [language, setLanguage] = useState('ko'); // 기본 언어: 요청에 따라 'ko'
  // 브라우저 기본 장치 ID 조회 (권한 전이면 'default'가 반환될 수 있음)
  const { activeDeviceId: defaultAudioId } = useMediaDeviceSelect({ kind: 'audioinput' });
  const { activeDeviceId: defaultVideoId } = useMediaDeviceSelect({ kind: 'videoinput' });

  // PreJoin 없이 자동 참가: 마운트 시 기본 사용자/언어로 토큰 발급 → 접속
  React.useEffect(() => {
    let cancelled = false;
    async function autoJoin() {
      try {
        if (connectionDetails) return;
        const username = `테스터${randomString(4)}`;
        const choices: LocalUserChoices = {
          username,
          videoEnabled: true,
          audioEnabled: true,
          videoDeviceId: defaultVideoId || 'default',
          audioDeviceId: defaultAudioId || 'default',
        };
        setPreJoinChoices(choices);

        const metadata = JSON.stringify({ preferred_language: 'ko' });
        const url = new URL(CONN_DETAILS_ENDPOINT, window.location.origin);
        url.searchParams.append('roomName', props.roomName);
        url.searchParams.append('participantName', username);
        url.searchParams.append('metadata', metadata);
        if (props.region) url.searchParams.append('region', props.region);

        const resp = await fetch(url.toString());
        const data = await resp.json();
        if (!cancelled) setConnectionDetails(data);
      } catch (e) {
        console.error(e);
      }
    }
    autoJoin();
    return () => {
      cancelled = true;
    };
  }, [connectionDetails, props.roomName, props.region, defaultAudioId, defaultVideoId]);

  return (
    <main
      data-lk-theme="default"
      className="flex flex-col justify-center items-center h-full bg-black text-white p-4 md:p-2"
    >
      {connectionDetails && preJoinChoices ? (
        <VideoConferenceComponent
          connectionDetails={connectionDetails}
          userChoices={preJoinChoices}
          options={{ codec: props.codec, hq: props.hq }}
          language={language}
        />
      ) : (
        <div className="flex flex-col items-center gap-6 p-8 bg-neutral-900 rounded-2xl shadow border border-white/20">
          <div className="text-sm opacity-80">미팅에 연결 중…</div>
        </div>
      )}
    </main>
  );
}

function VideoConferenceComponent(props: {
  userChoices: LocalUserChoices;
  connectionDetails: ConnectionDetails;
  options: {
    hq: boolean;
    codec: VideoCodec;
  };
  language: string;
}) {
  const e2eePassphrase =
    typeof window !== 'undefined' && decodePassphrase(location.hash.substring(1));

  const worker =
    typeof window !== 'undefined' &&
    e2eePassphrase &&
    new Worker(new URL('livekit-client/e2ee-worker', import.meta.url));
  const e2eeEnabled = !!(e2eePassphrase && worker);
  const keyProvider = new ExternalE2EEKeyProvider();
  const [e2eeSetupComplete, setE2eeSetupComplete] = React.useState(false);

  const roomOptions = React.useMemo((): RoomOptions => {
    let videoCodec: VideoCodec | undefined = props.options.codec ? props.options.codec : 'vp9';
    if (e2eeEnabled && (videoCodec === 'av1' || videoCodec === 'vp9')) {
      videoCodec = undefined;
    }
    return {
      videoCaptureDefaults: {
        deviceId: props.userChoices.videoDeviceId ?? undefined,
        resolution: props.options.hq ? VideoPresets.h2160 : VideoPresets.h720,
      },
      publishDefaults: {
        dtx: false,
        videoSimulcastLayers: props.options.hq
          ? [VideoPresets.h1080, VideoPresets.h720]
          : [VideoPresets.h540, VideoPresets.h216],
        red: !e2eeEnabled,
        videoCodec,
      },
      audioCaptureDefaults: {
        deviceId: props.userChoices.audioDeviceId ?? undefined,
      },
      adaptiveStream: { pixelDensity: 'screen' },
      dynacast: true,
      e2ee: e2eeEnabled
        ? {
            keyProvider,
            worker,
          }
        : undefined,
    };
  }, [props.userChoices, props.options.hq, props.options.codec, e2eeEnabled]);

  const room = React.useMemo(() => new Room(roomOptions), []);

  React.useEffect(() => {
    if (e2eeEnabled) {
      keyProvider
        .setKey(e2eePassphrase as string)
        .then(() => {
          room.setE2EEEnabled(true).catch((e) => {
            if (e instanceof DeviceUnsupportedError) {
              alert(
                `You're trying to join an encrypted meeting, but your browser does not support it. Please update it to the latest version and try again.`,
              );
              console.error(e);
            } else {
              throw e;
            }
          });
        })
        .then(() => setE2eeSetupComplete(true));
    } else {
      setE2eeSetupComplete(true);
    }
  }, [e2eeEnabled, room, e2eePassphrase]);

  const connectOptions = React.useMemo((): RoomConnectOptions => {
    return {
      autoSubscribe: true,
    };
  }, []);

  const router = useRouter();
  const handleOnLeave = React.useCallback(() => router.push('/'), [router]);
  const handleError = React.useCallback((error: Error) => {
    console.error(error);
    alert(`Encountered an unexpected error, check the console logs for details: ${error.message}`);
  }, []);
  const handleEncryptionError = React.useCallback((error: Error) => {
    console.error(error);
    alert(
      `Encountered an unexpected encryption error, check the console logs for details: ${error.message}`,
    );
  }, []);

  const [showTranscriptions, setShowTranscriptions] = useState(false);
  const [showQR, setShowQR] = useState(false);

  useEffect(() => {
    if (!room || !room.localParticipant) return;

    const syncTranslatedTrack = (
      publication: RemoteTrackPublication,
      participant: RemoteParticipant,
    ) => {
      const publisherIdentity = participant.identity;

      if (publication.kind === 'audio' && publication.trackName === 'translated') {
        const isFromSelf = publisherIdentity === room.localParticipant.identity;
        const isAgentToSelf = publisherIdentity.endsWith(`-to-${room.localParticipant.identity}`);
        publication.setSubscribed(isAgentToSelf && !isFromSelf); // 상대방 트랙만 구독
      }
    };

    const syncParticipantConnected = (participant: RemoteParticipant) => {
      const publisherIdentity = participant.identity;

      for (const pub of participant.trackPublications.values()) {
        if (pub.kind === 'audio' && pub.trackName === 'translated') {
          const isFromSelf = publisherIdentity === room.localParticipant.identity;
          const isAgentToSelf = publisherIdentity.endsWith(`-to-${room.localParticipant.identity}`);

          pub.setSubscribed(isAgentToSelf && !isFromSelf);
        }
      }
    };

    room.on('trackPublished', syncTranslatedTrack);
    room.on('participantConnected', syncParticipantConnected);

    return () => {
      room.off('trackPublished', syncTranslatedTrack);
      room.off('participantConnected', syncParticipantConnected);
    };
  }, [room]);

  return (
    <LiveKitRoom
      connect={e2eeSetupComplete}
      room={room}
      token={props.connectionDetails.participantToken}
      serverUrl={props.connectionDetails.serverUrl}
      connectOptions={connectOptions}
      video={props.userChoices.videoEnabled}
      audio={props.userChoices.audioEnabled}
      onDisconnected={handleOnLeave}
      onEncryptionError={handleEncryptionError}
      onError={handleError}
      style={{ backgroundColor: '#000' }}
    >
      <div
        style={{
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '8px',
        }}
      >
        <CustomTrack
          showTranscriptions={showTranscriptions}
          setShowTranscriptions={setShowTranscriptions}
          language={props.language}
          selfName={room.localParticipant?.name ?? ''}
          room={room}
        />
      </div>
      <RecordingIndicator />
      <RoomAudioRenderer />
      {showQR && <QRCodeDisplay url={window.location.href} onClose={() => setShowQR(false)} />}
      <DebugMode logLevel={LogLevel.debug} />
    </LiveKitRoom>
  );
}

function CustomTrack({
  showTranscriptions,
  setShowTranscriptions,
  language,
  selfName,
  room,
}: {
  showTranscriptions: boolean;
  setShowTranscriptions: (val: boolean) => void;
  language: string;
  selfName: string;
  room: Room;
}) {
  const [widgetState, setWidgetState] = React.useState<WidgetState>({
    showChat: false,
    unreadMessages: 0,
  });

  const [showLanguageSelector, setShowLanguageSelector] = React.useState(false);

  const handleShowLanguageSelector = useCallback(() => {
    setShowLanguageSelector(!showLanguageSelector);
  }, [showLanguageSelector, setShowLanguageSelector]);

  const rawTracks = useTracks([Track.Source.Camera, Track.Source.Microphone], {
    onlySubscribed: false,
  }).filter((track) => !track.participant.isAgent);

  // 카메라가 있으면 카메라, 없으면 마이크를 대표로 선택
  const tracks = React.useMemo(() => {
    const bySid = new Map<string, (typeof rawTracks)[number]>();

    for (const tr of rawTracks) {
      const sid = tr.participant.sid;
      const prev = bySid.get(sid);

      // 이미 저장된 게 없거나, 현재 트랙이 '카메라'라면 교체 (카메라 우선)
      if (!prev) {
        bySid.set(sid, tr);
        continue;
      }
      const prevIsCam = isTrackReference(prev) && prev.source === Track.Source.Camera;
      const curIsCam = isTrackReference(tr) && tr.source === Track.Source.Camera;
      if (!prevIsCam && curIsCam) {
        bySid.set(sid, tr);
      }
    }

    return Array.from(bySid.values());
  }, [rawTracks]);

  return (
    <LayoutContextProvider onWidgetChange={setWidgetState}>
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
          position: 'relative',
        }}
      >
        <div
          style={{
            width: '100%',
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            rowGap: 8,
            minHeight: 0,
            position: 'relative',
          }}
        >
          <div style={{ width: '100%', height: '100%', position: 'relative', minHeight: 0 }}>
            <FocusArea tracks={tracks} room={room} showTranscriptions={showTranscriptions} />
          </div>

          {showTranscriptions && <TranslationRealtime selfName={selfName} />}
        </div>

        <LanguageBottomDrawer
          initialLanguage={language}
          open={showLanguageSelector}
          handleOpen={handleShowLanguageSelector}
        />
        <CustomControlBar
          variation="minimal"
          style={{
            display: 'flex',
            width: '100%',
            justifyContent: 'space-between',
            alignItems: 'center',
            backgroundColor: '#404040',
            borderRadius: '20px',
          }}
          controls={{ microphone: true, screenShare: false, camera: false, chat: true }}
          setShowTranscriptions={setShowTranscriptions}
          showTranscriptions={showTranscriptions}
          handleShowLanguageSelector={handleShowLanguageSelector}
          showLanguageSelector={showLanguageSelector}
        />
      </div>
    </LayoutContextProvider>
  );
}

function FocusArea({
  tracks,
  room,
  showTranscriptions,
}: {
  tracks: TrackReferenceOrPlaceholder[];
  room: Room;
  showTranscriptions: boolean;
}) {
  const pinnedTracks = usePinnedTracks();
  const localPlaceholder = React.useMemo<TrackReferenceOrPlaceholder | undefined>(() => {
    if (room?.localParticipant) {
      return { participant: room.localParticipant, source: Track.Source.Camera };
    }
    return undefined;
  }, [room]);

  const focusRef = React.useMemo(
    () => pinnedTracks[0] ?? tracks[0] ?? localPlaceholder,
    [pinnedTracks, tracks, localPlaceholder],
  );

  // Build side list: only non-focused camera tracks
  const pinnedKeys = React.useMemo(() => {
    return new Set(pinnedTracks.map((t: any) => `${t?.participant?.sid}|${t?.source}`));
  }, [pinnedTracks]);

  const isSameRef = React.useCallback(
    (a?: TrackReferenceOrPlaceholder, b?: TrackReferenceOrPlaceholder) => {
      if (!a || !b) return false;
      const ap: any = a as any;
      const bp: any = b as any;
      return ap?.participant?.sid === bp?.participant?.sid && ap?.source === bp?.source;
    },
    [],
  );

  const sideTracks = React.useMemo(() => {
    return tracks
      .filter((tr) => isTrackReference(tr) && tr.source === Track.Source.Camera)
      .filter((tr) => {
        const key = `${tr.participant.sid}|${tr.source}`;
        if (pinnedKeys.has(key)) return false;
        if (focusRef && isSameRef(tr, focusRef)) return false;
        return true;
      });
  }, [tracks, pinnedKeys, focusRef, isSameRef]);

  return (
    <FocusLayoutContainer
      style={{ position: 'relative', display: 'flex', height: '100%', width: '100%', padding: 0 }}
    >
      <CarouselLayout
        tracks={sideTracks}
        style={{
          position: 'absolute',
          gap: 8,
          zIndex: 30,
          bottom: '8px',
          right: '8px',
        }}
      >
        <CustomParticipantTile
          room={room}
          barCount={3}
          style={{
            width: 160,
            height: 90,
            border: '#ffffff33 1px solid',
            borderRadius: 8,
          }}
        />
      </CarouselLayout>

      {focusRef ? (
        <FocusLayout trackRef={focusRef} style={{ height: '100%', width: '100%' }}>
          <div style={{ position: 'relative', width: '100%', height: '100%' }}>
            <CustomParticipantTile
              barCount={5}
              style={{
                border: '#ffffff33 1px solid',
                position: 'absolute',
                width: '100%',
                height: '100%',
                top: 0,
                left: 0,
                zIndex: showTranscriptions ? 1 : 0,
              }}
              room={room}
            />
          </div>
        </FocusLayout>
      ) : (
        <div style={{ width: '100%', height: '100%' }} />
      )}
    </FocusLayoutContainer>
  );
}
