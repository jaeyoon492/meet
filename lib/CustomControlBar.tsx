import { Track } from 'livekit-client';
import * as React from 'react';
import { supportsScreenSharing } from '@livekit/components-core';
import type { TrackReferenceOrPlaceholder } from '@livekit/components-core';
import {
  DisconnectButton,
  StartMediaButton,
  TrackToggle,
  useLocalParticipantPermissions,
  useLocalParticipant,
  useMaybeLayoutContext,
  usePersistentUserChoices,
  useTrackMutedIndicator,
} from '@livekit/components-react';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { mergeProps } from '@/utils/utils';
import ChatIcon from '@/components/ui/ChatIcon';
import ChatCloseIcon from '@/components/ui/ChatCloseIcon';
import MicIcon from '@/components/ui/MicIcon';
import MicMuteIcon from '@/components/ui/MicMuteIcon';
import LanguageIcon from '@/components/ui/LanguageIcon';
import LeaveIcon from '@/components/ui/LeaveIcon';

/** @public */
export type ControlBarControls = {
  microphone?: boolean;
  camera?: boolean;
  chat?: boolean;
  screenShare?: boolean;
  leave?: boolean;
  settings?: boolean;
};

/** @public */
export interface ControlBarProps extends React.HTMLAttributes<HTMLDivElement> {
  onDeviceError?: (error: { source: Track.Source; error: Error }) => void;
  variation?: 'minimal' | 'verbose' | 'textOnly';
  controls?: ControlBarControls;
  saveUserChoices?: boolean;
  setShowTranscriptions: (val: boolean) => void;
  showTranscriptions: boolean;
  showLanguageSelector: boolean;
  handleShowLanguageSelector: () => void;
}

export function CustomControlBar({
  variation,
  controls,
  saveUserChoices = true,
  onDeviceError,
  setShowTranscriptions,
  showTranscriptions,
  handleShowLanguageSelector,
  showLanguageSelector,
  ...props
}: ControlBarProps) {
  const [isChatOpen, setIsChatOpen] = React.useState(false);
  const layoutContext = useMaybeLayoutContext();
  React.useEffect(() => {
    if (layoutContext?.widget.state?.showChat !== undefined) {
      setIsChatOpen(layoutContext?.widget.state?.showChat);
    }
  }, [layoutContext?.widget.state?.showChat]);
  const isTooLittleSpace = useMediaQuery(`(max-width: ${isChatOpen ? 1000 : 760}px)`);

  const defaultVariation = isTooLittleSpace ? 'minimal' : 'verbose';
  variation ??= defaultVariation;

  const visibleControls = { leave: true, ...controls };

  const localPermissions = useLocalParticipantPermissions();

  if (!localPermissions) {
    visibleControls.camera = false;
    visibleControls.chat = false;
    visibleControls.microphone = false;
    visibleControls.screenShare = false;
  } else {
    visibleControls.camera ??= localPermissions.canPublish;
    visibleControls.microphone ??= localPermissions.canPublish;
    visibleControls.screenShare ??= localPermissions.canPublish;
    visibleControls.chat ??= localPermissions.canPublishData && controls?.chat;
  }

  const showIcon = React.useMemo(
    () => variation === 'minimal' || variation === 'verbose',
    [variation],
  );
  const showText = React.useMemo(
    () => variation === 'textOnly' || variation === 'verbose',
    [variation],
  );
  const browserSupportsScreenSharing = supportsScreenSharing();

  const [isScreenShareEnabled, setIsScreenShareEnabled] = React.useState(false);

  const onScreenShareChange = React.useCallback(
    (enabled: boolean) => {
      setIsScreenShareEnabled(enabled);
    },
    [setIsScreenShareEnabled],
  );

  const htmlProps = mergeProps({ className: 'lk-control-bar' }, props);

  const {
    userChoices,
    saveAudioInputEnabled,
    saveVideoInputEnabled,
    saveAudioInputDeviceId,
    saveVideoInputDeviceId,
  } = usePersistentUserChoices({ preventSave: !saveUserChoices });

  const microphoneOnChange = React.useCallback(
    (enabled: boolean, isUserInitiated: boolean) =>
      isUserInitiated ? saveAudioInputEnabled(enabled) : null,
    [saveAudioInputEnabled],
  );

  const cameraOnChange = React.useCallback(
    (enabled: boolean, isUserInitiated: boolean) =>
      isUserInitiated ? saveVideoInputEnabled(enabled) : null,
    [saveVideoInputEnabled],
  );

  // 실제 로컬 마이크 트랙의 mute 상태를 구해 아이콘과 동기화
  const { localParticipant } = useLocalParticipant();
  const micTrackRef = React.useMemo<TrackReferenceOrPlaceholder | undefined>(
    () =>
      localParticipant
        ? { participant: localParticipant, source: Track.Source.Microphone }
        : undefined,
    [localParticipant],
  );
  const { isMuted: isMicMuted } = useTrackMutedIndicator(micTrackRef);

  React.useEffect(() => {
    console.log(userChoices.audioEnabled);
  }, [userChoices.audioEnabled]);

  return (
    <div {...htmlProps}>
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <TrackToggle
          source={Track.Source.Microphone}
          showIcon={false}
          onChange={microphoneOnChange}
          onDeviceError={(error) => onDeviceError?.({ source: Track.Source.Microphone, error })}
          style={{ backgroundColor: '#404040', border: 'none', padding: '0px 16px' }}
        >
          {isMicMuted ? <MicMuteIcon /> : <MicIcon />}
        </TrackToggle>

        <button
          className="lk-button"
          style={{ backgroundColor: '#404040', border: 'none', padding: '0px 16px' }}
          onClick={() => setShowTranscriptions(!showTranscriptions)}
        >
          {showTranscriptions ? <ChatCloseIcon /> : <ChatIcon />}
        </button>

        <button
          className="lk-button"
          style={{ backgroundColor: '#404040', border: 'none', padding: '0px 16px' }}
          onClick={handleShowLanguageSelector}
        >
          <LanguageIcon />
        </button>
      </div>

      <DisconnectButton style={{ backgroundColor: '#404040', border: 'none', padding: '0px 16px' }}>
        {showIcon && <LeaveIcon />}
      </DisconnectButton>
    </div>
  );
}
