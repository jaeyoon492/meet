'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import React, { Suspense, useState } from 'react';
import { encodePassphrase, generateRoomId, randomString } from '@/lib/client-utils';

function DemoMeeting(props: {}) {
  const router = useRouter();
  const [e2ee, setE2ee] = useState(false);
  const [sharedPassphrase, setSharedPassphrase] = useState(randomString(64));

  const startMeeting = () => {
    const path = `/rooms/${generateRoomId()}`;
    const fullPath = e2ee ? `${path}#${encodePassphrase(sharedPassphrase)}` : path;
    router.push(fullPath);
  };

  return (
    <div className="bg-[#121212] p-6 rounded-2xl shadow max-w-md w-full border border-neutral-800">
      <h2 className="text-xl mb-4 text-white">Quick Start</h2>
      <p className="mb-6 text-neutral-300">Start a demo translation meeting instantly.</p>
      <button className="lk-button mt-4" onClick={startMeeting}>
        Start Demo Meeting
      </button>
    </div>
  );
}

export default function Page() {
  return (
    <div className="min-h-screen bg-black text-white flex flex-col">
      <main className="flex-1 flex flex-col justify-center items-center px-8 py-16" data-lk-theme="default">
        <header className="text-center mb-12">
          <h1 className="text-4xl font-bold text-white">Live Translate Demo 🔊</h1>
          <p className="text-lg text-neutral-300 mt-2">
            Experience real-time voice translation powered by LiveKit + AI
          </p>
        </header>
        <Suspense fallback={<p>Loading...</p>}>
          <DemoMeeting />
        </Suspense>
      </main>
      <footer className="p-6 text-center bg-black text-neutral-400 text-sm border-t border-neutral-800">
        © 2025 Voice Translate Demo
      </footer>
    </div>
  );
}
