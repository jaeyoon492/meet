import * as React from 'react';
import { Participant, Room, TrackPublication } from 'livekit-client';
import { Track } from 'livekit-client';
import type {
  ParticipantClickEvent,
  TrackReference,
  TrackReferenceOrPlaceholder,
} from '@livekit/components-core';
import { isTrackReference, isTrackReferencePinned } from '@livekit/components-core';
import {
  AudioTrack,
  BarVisualizer,
  ConnectionQualityIndicator,
  FocusToggle,
  LockLockedIcon,
  ParticipantContext,
  ParticipantName,
  ParticipantPlaceholder,
  ScreenShareIcon,
  TrackMutedIndicator,
  TrackRefContext,
  useEnsureTrackRef,
  useFeatureContext,
  useIsEncrypted,
  useMaybeLayoutContext,
  useMaybeParticipantContext,
  useMaybeTrackRefContext,
  useParticipantTile,
  VideoTrack,
} from '@livekit/components-react';
import { Overlay } from './Overlay';

function ParticipantContextIfNeeded(props: React.PropsWithChildren<{ participant?: Participant }>) {
  const hasContext = !!useMaybeParticipantContext();
  return props.participant && !hasContext ? (
    <ParticipantContext.Provider value={props.participant}>
      {props.children}
    </ParticipantContext.Provider>
  ) : (
    <>{props.children}</>
  );
}

function TrackRefContextIfNeeded(
  props: React.PropsWithChildren<{ trackRef?: TrackReferenceOrPlaceholder }>,
) {
  const hasContext = !!useMaybeTrackRefContext();
  return props.trackRef && !hasContext ? (
    <TrackRefContext.Provider value={props.trackRef}>{props.children}</TrackRefContext.Provider>
  ) : (
    <>{props.children}</>
  );
}

export interface ParticipantTileProps extends React.HTMLAttributes<HTMLDivElement> {
  trackRef?: TrackReferenceOrPlaceholder;
  disableSpeakingIndicator?: boolean;
  onParticipantClick?: (event: ParticipantClickEvent) => void;
  barCount?: number;
  room: Room;
}

export const CustomParticipantTile = React.forwardRef<HTMLDivElement, ParticipantTileProps>(
  function ParticipantTile(
    {
      trackRef,
      children,
      onParticipantClick,
      disableSpeakingIndicator,
      barCount = 6,
      room,
      ...htmlProps
    }: ParticipantTileProps,
    ref,
  ) {
    const givenTrackRef = useEnsureTrackRef(trackRef);

    const { elementProps } = useParticipantTile<HTMLDivElement>({
      htmlProps,
      disableSpeakingIndicator,
      onParticipantClick,
      trackRef: givenTrackRef,
    });

    const participant = givenTrackRef.participant;
    const isEncrypted = useIsEncrypted(participant);
    const layoutContext = useMaybeLayoutContext();
    const autoManageSubscription = useFeatureContext()?.autoSubscription;
    const containerRef = React.useRef<HTMLDivElement>(null);

    // --- 1) 퍼블리케이션 상태 가져오기 ---
    const camPub = participant.getTrackPublication(Track.Source.Camera);
    const micPub = participant.getTrackPublication(Track.Source.Microphone);

    const isCameraTile = givenTrackRef.source === Track.Source.Camera;
    // publication 업데이트 타이밍에 덜 민감하도록 source 기반으로 우선 판별
    const showVideo = isCameraTile && (camPub ? !camPub.isMuted : true);

    const audioReady =
      !!micPub?.track?.mediaStreamTrack &&
      micPub.track.mediaStreamTrack.kind === 'audio' &&
      micPub.track.mediaStreamTrack.readyState === 'live' &&
      micPub.isSubscribed &&
      !micPub.isMuted;

    const showAudioBars = !showVideo && audioReady;

    // --- 2) 각 소스별 TrackRef 구성 ---
    const cameraRef = React.useMemo<TrackReference | undefined>(
      () =>
        camPub
          ? {
              participant,
              source: Track.Source.Camera,
              publication: camPub as TrackPublication, // typing 보강
            }
          : undefined,
      [participant, camPub],
    );

    const microphoneRef = React.useMemo(
      () =>
        micPub ? { participant, source: Track.Source.Microphone, publication: micPub } : undefined,
      [participant, micPub],
    );

    const handleSubscribe = React.useCallback(
      (subscribed: boolean) => {
        if (
          givenTrackRef.source &&
          !subscribed &&
          layoutContext &&
          layoutContext.pin.dispatch &&
          isTrackReferencePinned(givenTrackRef, layoutContext.pin.state)
        ) {
          layoutContext.pin.dispatch({ msg: 'clear_pin' });
        }
      },
      [givenTrackRef, layoutContext],
    );

    const getBestVideoEl = React.useCallback((): HTMLVideoElement | null => {
      const root = containerRef.current;
      if (!root) return null;

      const videos = Array.from(root.querySelectorAll('video'));
      if (!videos.length) return null;

      return (
        videos.find(
          (v) =>
            v.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
            v.videoWidth > 0 &&
            v.videoHeight > 0 &&
            v.clientWidth > 0 &&
            v.clientHeight > 0,
        ) ??
        videos.find(
          (v) =>
            v.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
            v.videoWidth > 0 &&
            v.videoHeight > 0,
        ) ??
        videos[0]
      );
    }, []);

    return (
      <div ref={ref} style={{ position: 'relative' }} {...elementProps}>
        <div ref={containerRef} style={{ position: 'relative', width: '100%', height: '100%' }}>
          {/* TrackRef/Participant 컨텍스트 보장 */}
          <TrackRefContextIfNeeded trackRef={givenTrackRef}>
            <ParticipantContextIfNeeded participant={participant}>
              {children ?? (
                <>
                  {/* --- 3) 표시 로직: 비디오 > 오디오 바 > 플레이스홀더 --- */}
                  {showVideo ? (
                    <TrackRefContextIfNeeded trackRef={cameraRef ?? givenTrackRef}>
                      <VideoTrack
                        key={`${participant.sid}-cam`}
                        style={{ objectFit: 'contain', transform: 'none' }}
                      />
                    </TrackRefContextIfNeeded>
                  ) : showAudioBars && microphoneRef ? (
                    // ★ 마이크 컨텍스트 강제 + AudioTrack을 먼저 렌더
                    <TrackRefContextIfNeeded trackRef={microphoneRef}>
                      <AudioTrack
                        trackRef={microphoneRef}
                        onSubscriptionStatusChanged={handleSubscribe}
                      />
                      <BarVisualizer
                        trackRef={microphoneRef}
                        key={`${participant.sid}-mic`} // ★ 전환 시 리마운트
                        barCount={barCount}
                        options={{ minHeight: 8 }}
                      />
                    </TrackRefContextIfNeeded>
                  ) : (
                    <div className="lk-participant-placeholder">
                      <ParticipantPlaceholder />
                    </div>
                  )}

                  {/* --- 4) 메타데이터 영역 --- */}
                  <div
                    className="lk-participant-metadata"
                    style={{ top: '.25rem', bottom: 'auto' }}
                  >
                    <div className="lk-participant-metadata-item">
                      {showVideo ? (
                        <>
                          {isEncrypted && <LockLockedIcon style={{ marginRight: '0.25rem' }} />}
                          <TrackMutedIndicator
                            trackRef={{
                              participant,
                              source: Track.Source.Microphone,
                            }}
                            show={'muted'}
                          />
                          <ParticipantName />
                        </>
                      ) : showAudioBars ? (
                        <>
                          {/* 오디오 전용일 때도 이름/뮤트 표시 */}
                          <TrackMutedIndicator
                            trackRef={{
                              participant,
                              source: Track.Source.Microphone,
                            }}
                            show={'muted'}
                          />
                          <ParticipantName />
                        </>
                      ) : (
                        <>
                          <ScreenShareIcon style={{ marginRight: '0.25rem' }} />
                          <ParticipantName>&apos;s screen</ParticipantName>
                        </>
                      )}
                    </div>
                    <ConnectionQualityIndicator className="lk-participant-metadata-item" />
                  </div>

                  {/* --- 5) 비디오일 때만 Overlay 렌더 --- */}
                  {showVideo && (
                    <Overlay
                      key={`${participant.sid}-overlay`}
                      room={room}
                      getVideoEl={getBestVideoEl}
                      participantIdentity={participant.identity}
                    />
                  )}
                </>
              )}
              {/* 포커스 토글은 주 TrackRef로 동작 */}
              <FocusToggle trackRef={givenTrackRef} />
            </ParticipantContextIfNeeded>
          </TrackRefContextIfNeeded>
        </div>
      </div>
    );
  },
);
