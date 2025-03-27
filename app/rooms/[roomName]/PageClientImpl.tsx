'use client';

import { decodePassphrase } from '@/lib/client-utils';
import { RecordingIndicator } from '@/lib/RecordingIndicator';
import { ConnectionDetails } from '@/lib/types';
import {
  BarVisualizer,
  LiveKitRoom,
  LocalUserChoices,
  PreJoin,
  RoomAudioRenderer,
  useVoiceAssistant,
  AgentState,
  ControlBar,
  useTracks,
  LayoutContextProvider,
  useMaybeRoomContext,
  GridLayout,
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
  TranscriptionSegment,
  Participant,
  TrackPublication,
  RoomEvent,
} from 'livekit-client';
import { useRouter } from 'next/navigation';
import React, { useEffect, useState } from 'react';
import type { ReceivedTranscriptionSegment, WidgetState } from '@livekit/components-core';
import { LANGUAGE_OPTIONS } from '@/lib/constants';
import styles from '../../../styles/PageClient.module.css';
import { CustomParticipantTile } from '@/lib/CustomParticipantTile';
import { LanguageSelector } from '@/lib/LanguageSelector';

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
    <main data-lk-theme="default" className={styles.container}>
      {connectionDetails === undefined || preJoinChoices === undefined ? (
        <div className={styles.preJoinContainer}>
          <div className={styles.languageSelector}>
            <label htmlFor="language-select" className={styles.languageLabel}>
              Preferred Language:
            </label>
            <select
              id="language-select"
              value={language}
              onChange={handleChange}
              className={styles.languageSelect}
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

  const [agentState, setAgentState] = useState<AgentState>('disconnected');
  // 새로 추가한 state: 전사된 텍스트를 저장
  const [transcript, setTranscript] = useState<ReceivedTranscriptionSegment[]>([]);
  // const audioTracks = useTracks([Track.Source.Microphone]);
  const [showTranscriptions, setShowTranscriptions] = useState(false);

  return (
    <>
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
          <CustomVideoTrack
            showTranscriptions={showTranscriptions}
            setShowTranscriptions={setShowTranscriptions}
            language={props.language}
          />
        </div>
        <RecordingIndicator />
        <RoomAudioRenderer />
      </LiveKitRoom>
    </>
  );
}

function CustomVideoTrack({
  showTranscriptions,
  setShowTranscriptions,
  language,
}: {
  showTranscriptions: boolean;
  setShowTranscriptions: (val: boolean) => void;
  language: string;
}) {
  const [widgetState, setWidgetState] = React.useState<WidgetState>({
    showChat: false,
    unreadMessages: 0,
  });
  // const audioTracks = useTracks([Track.Source.Microphone]).filter(
  //   (track) => !track.participant.isAgent,
  // );

  const carouselTracks = useTracks([
    Track.Source.Microphone,
    Track.Source.ScreenShare,
    Track.Source.Camera,
  ]);
  console.log(carouselTracks);

  return (
    <LayoutContextProvider onWidgetChange={setWidgetState}>
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
          border: '#ffffff33 1px solid',
          borderRadius: '8px',
          position: 'relative',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            // borderTop: '1px solid rgba(255, 255, 255, 0.1)',
            // borderBottom: '1px solid rgba(255, 255, 255, 0.1)',
          }}
        >
          <ControlBar
            variation="minimal"
            style={{ borderTop: 'none' }}
            controls={{ microphone: true, screenShare: false, camera: true }}
          />
          <div style={{ display: 'flex', gap: 4 }}>
            <LanguageSelector language={language} />
            <button
              className="lk-button"
              onClick={() => setShowTranscriptions(!showTranscriptions)}
              style={{
                padding: '0.5rem 0.5rem',
                fontSize: '0.95rem',
                borderRadius: '0.5rem',
              }}
            >
              📝
            </button>
          </div>
        </div>
        <div
          style={{
            position: 'relative',
            width: '100%',
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <GridLayout tracks={carouselTracks}>
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
              />
            </div>
          </GridLayout>
          {showTranscriptions && <Transcriptions />}
        </div>
      </div>
    </LayoutContextProvider>
  );
}

function SimpleVoiceAssistant(props: {
  onStateChange: (state: AgentState) => void;
  // 전사 텍스트 업데이트를 위한 콜백 함수 (옵셔널)
  onTranscription?: (text: ReceivedTranscriptionSegment[]) => void;
}) {
  // useVoiceAssistant 훅이 전사 결과를 transcript 프로퍼티로 제공한다고 가정
  const { state, audioTrack, agentTranscriptions, agent } = useVoiceAssistant();

  useEffect(() => {
    props.onStateChange(state);
  }, [props, state]);

  // 전사 텍스트가 업데이트될 때마다 부모에 전달
  useEffect(() => {
    if (props.onTranscription && agentTranscriptions) {
      props.onTranscription(agentTranscriptions);
    }
  }, [agentTranscriptions, props]);

  return (
    <div className="h-[300px] max-w-[90vw] mx-auto">
      <BarVisualizer
        state={state}
        barCount={2}
        trackRef={audioTrack}
        className="agent-visualizer"
        options={{}}
      />
    </div>
  );
}

// Extended interface: participantName을 추가합니다.
interface ExtendedTranscriptionSegment extends TranscriptionSegment {
  participantName?: string;
}

export default function Transcriptions() {
  const room = useMaybeRoomContext();
  const [transcriptions, setTranscriptions] = useState<{
    [id: string]: ExtendedTranscriptionSegment;
  }>({});

  const [test, setTest] = useState([
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
    1,
  ]);

  useEffect(() => {
    if (!room) {
      return;
    }

    const updateTranscriptions = (
      segments: TranscriptionSegment[],
      participant?: Participant,
      publication?: TrackPublication,
    ) => {
      setTranscriptions((prev) => {
        const newTranscriptions = { ...prev };
        for (const segment of segments) {
          newTranscriptions[segment.id] = {
            ...segment,
            participantName: participant && participant.name ? participant.name : '번역기',
          };
        }
        return newTranscriptions;
      });
    };

    room.on(RoomEvent.TranscriptionReceived, updateTranscriptions);
    return () => {
      room.off(RoomEvent.TranscriptionReceived, updateTranscriptions);
    };
  }, [room]);

  return (
    <div className={styles.transcriptionBox}>
      <ul>
        {Object.values(transcriptions)
          .sort((a, b) => b.firstReceivedTime - a.firstReceivedTime)
          .map((segment) => (
            <li key={segment.id} style={{ listStyle: 'none' }}>
              [{segment.firstReceivedTime}]: [{segment.language}]: {segment.participantName}:
              {segment.text}
            </li>
          ))}
      </ul>
    </div>
  );
}
