import { useMaybeRoomContext } from '@livekit/components-react';
import { Participant, RoomEvent, TrackPublication, TranscriptionSegment } from 'livekit-client';
import { useEffect, useState } from 'react';
import styles from '../../../styles/PageClient.module.css';

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
    if (!room) return;

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
            participantName: participant?.name || '번역기',
          };
        }
        return newTranscriptions;
      });
    };

    const handleDataReceived = (payload: Uint8Array, participant?: Participant) => {
      try {
        const decoded = new TextDecoder().decode(payload);
        const data = JSON.parse(decoded);

        if (data.type === 'translation') {
          const id = `${Date.now()}-${Math.random()}`;
        }
      } catch (err) {
        console.warn('❌ Failed to parse data message:', err);
      }
    };

    room.on(RoomEvent.TranscriptionReceived, updateTranscriptions);
    room.on(RoomEvent.DataReceived, handleDataReceived); // 🔁 번역 데이터 수신

    return () => {
      room.off(RoomEvent.TranscriptionReceived, updateTranscriptions);
      room.off(RoomEvent.DataReceived, handleDataReceived);
    };
  }, [room]);

  return (
    <div className={styles.transcriptionBox}>
      <ul>
        {Object.values(transcriptions)
          .sort((a, b) => b.firstReceivedTime - a.firstReceivedTime)
          .map((segment) => (
            <li key={segment.id} style={{ listStyle: 'none' }}>
              {segment.participantName}: {segment.text}
            </li>
          ))}
      </ul>
    </div>
  );
}
