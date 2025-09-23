// lib/QRCodeDisplay.tsx
'use client';

import React from 'react';
import { QRCodeCanvas } from 'qrcode.react';

export function QRCodeDisplay({ url, onClose }: { url: string; onClose: () => void }) {
  return (
    <div className="fixed top-0 left-0 w-full bg-[#111] p-8 rounded-b-2xl shadow-[0_-4px_10px_rgba(0,0,0,0.3)] z-[1000] flex items-center justify-center animate-in slide-in-from-top duration-300 ease-out">
      <div className="text-center flex flex-col items-center justify-center">
        <QRCodeCanvas value={url} size={180} />
        <p className="text-white mt-4 break-words">{url}</p>
        <button
          onClick={onClose}
          className="mt-4 px-4 py-2 bg-neutral-700 text-white rounded-lg cursor-pointer"
        >
          닫기
        </button>
      </div>
    </div>
  );
}
