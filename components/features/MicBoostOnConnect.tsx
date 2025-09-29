import { useEffect } from 'react';
import { useMaybeRoomContext } from '@livekit/components-react';
import { RoomEvent, ConnectionState } from 'livekit-client';

export function MicBoostOnConnect() {
  const room = useMaybeRoomContext();

  useEffect(() => {
    if (!room) return () => {};

    const applyMicOpts = async () => {
      await room.localParticipant.setMicrophoneEnabled(true, {
        autoGainControl: true,
        noiseSuppression: true,
        echoCancellation: true,
        voiceIsolation: true, // 지원 브라우저에서만 적용됨(미지원이면 무시)
        sampleRate: 48000,
        channelCount: 1,
      });
    };

    if (room.state === ConnectionState.Connected) {
      applyMicOpts();
    } else {
      room.once(RoomEvent.Connected, applyMicOpts);
    }
    return () => room.off(RoomEvent.Connected, applyMicOpts);
  }, [room]);

  return null;
}
