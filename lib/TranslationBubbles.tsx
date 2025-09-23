'use client';

import React, { useEffect, useState } from 'react';
import { useMaybeRoomContext } from '@livekit/components-react';
import { RoomEvent } from 'livekit-client';
// Tailwind migration: replaced styles/TranslationBubbles.module.css with utility classes

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
    <div className="w-full h-full absolute z-30 overflow-y-scroll bg-neutral-900 p-4 border border-white/20 text-[0.95rem] rounded-md mr-2 mb-4 flex flex-col gap-1">
      {bubbles
        .slice(-10)
        .sort((a, b) => b.timestamp - a.timestamp)
        .map((bubble) => {
          const isSelf = bubble.from === selfName;

          return (
            <div
              key={bubble.id}
              className={
                isSelf
                  ? 'max-w-[70%] px-3 py-2 rounded-2xl text-white text-[0.95rem] inline-block relative self-end bg-sky-600/70'
                  : 'max-w-[70%] px-3 py-2 rounded-2xl text-white text-[0.95rem] inline-block relative self-start bg-white/10'
              }
            >
              <div className="text-xs opacity-70 mb-1">
                <span className="font-bold mr-1">{bubble.from}</span>
                <span className="ml-1">
                  {new Date(bubble.timestamp * 1000).toLocaleTimeString()}
                </span>
              </div>
              <div className="break-words">{bubble.text}</div>
              {<div className="text-sm opacity-50 mt-1">({bubble.original})</div>}
            </div>
          );
        })}
    </div>
  );
}
