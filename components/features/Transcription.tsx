import { useMaybeRoomContext } from '@livekit/components-react';
import { Participant, RoomEvent, TrackPublication, TranscriptionSegment } from 'livekit-client';
import { useEffect, useState } from 'react';

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
    <div className="w-full md:w-[500px] h-full overflow-y-auto bg-neutral-900 p-4 border border-white/20 text-white text-[0.95rem] rounded-md md:mr-2 md:mb-4">
      <ul className="list-none p-0 m-0">
        {Object.values(transcriptions)
          .sort((a, b) => b.firstReceivedTime - a.firstReceivedTime)
          .map((segment) => (
            <li key={segment.id} className="mb-3 border-b border-white/15 pb-2">
              {segment.participantName}: {segment.text}
            </li>
          ))}
      </ul>
    </div>
  );
}
