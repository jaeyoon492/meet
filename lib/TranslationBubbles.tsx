'use client';

import React, { useEffect, useState } from 'react';
import { useMaybeRoomContext } from '@livekit/components-react';
import { RoomEvent } from 'livekit-client';
import styles from '../styles/TranslationBubbles.module.css';

interface Bubble {
  id: string;
  from: string;
  fromIdentity: string;
  text: string;
  original: string;
  timestamp: number;
}

export function TranslationBubbles({ selfName }: { selfName: string }) {
  const room = useMaybeRoomContext();
  const [bubbles, setBubbles] = useState<Bubble[]>([]);

  useEffect(() => {
    if (!room) return;

    const handleDataReceived = (payload: Uint8Array) => {
      try {
        const decoded = new TextDecoder().decode(payload);
        const data = JSON.parse(decoded);

        if (data.type === 'translation') {
          setBubbles((prev) => [
            ...prev,
            {
              id: `${Date.now()}-${Math.random()}`,
              from: data.from,
              fromIdentity: data.fromIdentity,
              text: data.text,
              original: data.original,
              timestamp: data.timestamp,
            },
          ]);
        }
      } catch (err) {
        console.warn('Failed to parse translation payload:', err);
      }
    };

    room.on(RoomEvent.DataReceived, handleDataReceived);
    return () => {
      room.off(RoomEvent.DataReceived, handleDataReceived);
    };
  }, [room]);

  return (
    <div className={styles.bubblesContainer}>
      {bubbles
        .slice(-10)
        .sort((a, b) => b.timestamp - a.timestamp)
        .map((bubble) => {
          const isSelf = bubble.from === selfName;

          return (
            <div key={bubble.id} className={isSelf ? styles.bubbleRight : styles.bubbleLeft}>
              <div className={styles.meta}>
                <span className={styles.speaker}>{bubble.from}</span>
                <span className={styles.time}>
                  {new Date(bubble.timestamp * 1000).toLocaleTimeString()}
                </span>
              </div>
              <div className={styles.text}>{bubble.text}</div>
              {<div className={styles.original}>({bubble.original})</div>}
            </div>
          );
        })}
    </div>
  );
}
