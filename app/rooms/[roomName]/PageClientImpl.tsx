'use client';

import { decodePassphrase } from '@/lib/client-utils';
import { DebugMode } from '@/lib/Debug';
import { RecordingIndicator } from '@/lib/RecordingIndicator';
import { SettingsMenu } from '@/lib/SettingsMenu';
import { ConnectionDetails } from '@/lib/types';
import {
  AudioVisualizer,
  BarVisualizer,
  formatChatMessageLinks,
  LiveKitRoom,
  LocalUserChoices,
  PreJoin,
  RoomAudioRenderer,
  useVoiceAssistant,
  VideoConference,
  useTrackTranscription,
  AgentState,
  ControlBar,
  AudioConference,
  useTracks,
  LayoutContextProvider,
  TrackLoop,
  ParticipantAudioTile,
  Chat,
  useEnsureTrackRef,
  TrackRefContext,
  AudioTrack,
  useMaybeRoomContext,
  ParticipantName,
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

  const handlePreJoinSubmit = React.useCallback(async (values: LocalUserChoices) => {
    setPreJoinChoices(values);
    const url = new URL(CONN_DETAILS_ENDPOINT, window.location.origin);
    url.searchParams.append('roomName', props.roomName);
    url.searchParams.append('participantName', values.username);
    if (props.region) {
      url.searchParams.append('region', props.region);
    }
    const connectionDetailsResp = await fetch(url.toString());
    const connectionDetailsData = await connectionDetailsResp.json();
    setConnectionDetails(connectionDetailsData);
  }, []);
  const handlePreJoinError = React.useCallback((e: any) => console.error(e), []);

  return (
    <main data-lk-theme="default" style={{ height: '100%' }}>
      {connectionDetails === undefined || preJoinChoices === undefined ? (
        <div style={{ display: 'grid', placeItems: 'center', height: '100%' }}>
          <PreJoin
            defaults={preJoinDefaults}
            onSubmit={handlePreJoinSubmit}
            onError={handlePreJoinError}
          />
        </div>
      ) : (
        <VideoConferenceComponent
          connectionDetails={connectionDetails}
          userChoices={preJoinChoices}
          options={{ codec: props.codec, hq: props.hq }}
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
          }}
        >
          {/* <AudioConference /> */}
          <CustomAudioTrack />
          {/* <SimpleVoiceAssistant onStateChange={setAgentState} onTranscription={setTranscript} /> */}
          <Transcriptions />
        </div>
        <RecordingIndicator />
        <RoomAudioRenderer />
      </LiveKitRoom>
    </>
  );
}

function CustomAudioTrack() {
  const [widgetState, setWidgetState] = React.useState<WidgetState>({
    showChat: false,
    unreadMessages: 0,
  });
  // const audioTracks = useTracks([Track.Source.Microphone]).filter(
  //   (track) => track.participant.isLocal,
  // );

  const audioTracks = useTracks([Track.Source.Microphone]);

  return (
    <LayoutContextProvider onWidgetChange={setWidgetState}>
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
        <div
          className="lk-audio-conference-stage"
          style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'row' }}
        >
          {audioTracks.map((item) => (
            <>
              <ParticipantAudioTile trackRef={item} style={{ height: '100%', width: '100%' }} />
            </>
          ))}
          <ControlBar
            variation="minimal"
            controls={{ microphone: true, screenShare: false, camera: false, chat: true }}
          />
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
    <ul style={{ width: '500px', height: '100%', border: 'white solid 1px' }}>
      {Object.values(transcriptions)
        .sort((a, b) => a.firstReceivedTime - b.firstReceivedTime)
        .map((segment) => (
          <li key={segment.id}>
            {segment.participantName}: {segment.text}
          </li>
        ))}
    </ul>
  );
}
