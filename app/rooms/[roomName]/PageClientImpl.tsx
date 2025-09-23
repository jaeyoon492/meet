'use client';

import { decodePassphrase } from '@/lib/client-utils';
import { RecordingIndicator } from '@/lib/RecordingIndicator';
import { ConnectionDetails } from '@/lib/types';
import {
  LiveKitRoom,
  LocalUserChoices,
  PreJoin,
  RoomAudioRenderer,
  AgentState,
  ControlBar,
  useTracks,
  LayoutContextProvider,
  GridLayout,
  CarouselLayout,
  TrackLoop,
  VoiceAssistantControlBar,
  isTrackReference,
  FocusLayoutContainer,
  FocusLayout,
  usePinnedTracks,
  FocusToggle,
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
import type {
  ReceivedTranscriptionSegment,
  WidgetState,
  TrackReferenceOrPlaceholder,
} from '@livekit/components-core';
import { LANGUAGE_OPTIONS } from '@/lib/constants';
import { CustomParticipantTile } from '@/lib/CustomParticipantTile';
import { LanguageSelector } from '@/lib/LanguageSelector';
import { TranslationBubbles } from '@/lib/TranslationBubbles';
import { QRCodeDisplay } from '@/lib/QRCodeDisplay';
import { DebugMode } from '@/lib/Debug';
import MyKrispSetting from '@/lib/MyKrispSetting';
import { Overlay } from '@/lib/Overlay';
import TranslationRealtime from '@/lib/TranslationRealtime';
import { MicBoostOnConnect } from '@/lib/MicBoostOnConnect';
import { CustomControlBar } from '@/lib/CustomControlBar';
import { LanguageBottomDrawer } from '@/lib/Language';

const CONN_DETAILS_ENDPOINT =
  process.env.NEXT_PUBLIC_CONN_DETAILS_ENDPOINT ?? '/api/connection-details';
const SHOW_SETTINGS_MENU = process.env.NEXT_PUBLIC_SHOW_SETTINGS_MENU == 'true';

export function PageClientImpl(props: {
  roomName: string;
  region?: string;
  hq: boolean;
  codec: VideoCodec;
}) {
  const [preJoinChoices, setPreJoinChoices] = React.useState<LocalUserChoices | undefined>(
    undefined,
  );
  const preJoinDefaults = React.useMemo(() => {
    return {
      username: '',
      videoEnabled: true,
      audioEnabled: true,
    };
  }, []);
  const [connectionDetails, setConnectionDetails] = React.useState<ConnectionDetails | undefined>(
    undefined,
  );
  const [language, setLanguage] = useState('en'); // 기본 언어
  const handleChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    setLanguage(e.target.value);
  };

  const handlePreJoinSubmit = React.useCallback(
    async (values: LocalUserChoices) => {
      setPreJoinChoices(values);

      const metadata = JSON.stringify({
        preferred_language: language, // 👈 여기서 선택된 언어를 포함
      });

      const url = new URL(CONN_DETAILS_ENDPOINT, window.location.origin);
      url.searchParams.append('roomName', props.roomName);
      url.searchParams.append('participantName', values.username);
      url.searchParams.append('metadata', metadata); // 👈 추가된 부분

      if (props.region) {
        url.searchParams.append('region', props.region);
      }

      const connectionDetailsResp = await fetch(url.toString());
      const connectionDetailsData = await connectionDetailsResp.json();
      setConnectionDetails(connectionDetailsData);
    },
    [language, props.roomName, props.region],
  );
  const handlePreJoinError = React.useCallback((e: any) => console.error(e), []);

  return (
    <main
      data-lk-theme="default"
      className="flex flex-col justify-center items-center h-full bg-black text-white p-4 md:p-2"
    >
      {connectionDetails === undefined || preJoinChoices === undefined ? (
        <div className="flex flex-col items-center gap-6 p-8 bg-neutral-900 rounded-2xl shadow border border-white/20 w-min">
          <div className="flex items-center justify-center gap-2.5">
            <label htmlFor="language-select" className="text-base font-semibold text-neutral-100">
              Preferred Language:
            </label>
            <select
              id="language-select"
              value={language}
              onChange={handleChange}
              className="px-4 py-2 rounded-md border border-white/50 bg-black text-white text-base focus:outline-none focus:border-white"
            >
              {LANGUAGE_OPTIONS.map((lang) => (
                <option key={lang.code} value={lang.code}>
                  {lang.label}
                </option>
              ))}
            </select>
          </div>
          <PreJoin
            defaults={preJoinDefaults}
            onSubmit={handlePreJoinSubmit}
            onError={handlePreJoinError}
            style={{
              borderRadius: '12px',
              background: 'linear-gradient(to bottom right, #181717, #1a1a1a)',
              boxShadow: '0 4px 12px rgba(0, 0, 0, 0.7)',
              display: 'grid',
              alignItems: 'center',
            }}
          />
        </div>
      ) : (
        <VideoConferenceComponent
          connectionDetails={connectionDetails}
          userChoices={preJoinChoices}
          options={{ codec: props.codec, hq: props.hq }}
          language={language}
        />
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
  console.log('Connection Datail', props.connectionDetails);

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
  }, [props.userChoices, props.options.hq, props.options.codec]);

  const room = React.useMemo(() => new Room(roomOptions), []);

  React.useEffect(() => {
    if (e2eeEnabled) {
      keyProvider
        .setKey(decodePassphrase(e2eePassphrase))
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
        console.log(
          `[trackPublished] publisher: ${publisherIdentity}, self: ${room.localParticipant.identity}`,
        );
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
            display: 'grid',
            gridTemplateColumns: '1fr',
            rowGap: 8,
            minHeight: 0,
            position: 'relative',
          }}
        >
          <div style={{ position: 'relative', minHeight: 0 }}>
            <FocusArea tracks={tracks} room={room} showTranscriptions={showTranscriptions} />
          </div>

          {showTranscriptions && <TranslationRealtime selfName={selfName} />}
        </div>

        <LanguageBottomDrawer open={showLanguageSelector} handleOpen={handleShowLanguageSelector} />
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
          bottom: '4px',
          right: '4px',
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
