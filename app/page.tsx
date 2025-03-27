'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import React, { Suspense, useState } from 'react';
import { encodePassphrase, generateRoomId, randomString } from '@/lib/client-utils';
import styles from '../styles/Home.module.css';

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
    <div className={styles.tabContent}>
      <h2>Quick Start</h2>
      <p>Start a demo translation meeting instantly.</p>
      <button className="lk-button" onClick={startMeeting} style={{ marginTop: '1rem' }}>
        Start Demo Meeting
      </button>
    </div>
  );
}

export default function Page() {
  return (
    <div className={styles.pageWrapper}>
      <main className={styles.main} data-lk-theme="default">
        <header className={styles.header}>
          <h1>Live Translate Demo 🔊</h1>
          <p>Experience real-time voice translation powered by LiveKit + AI</p>
        </header>
        <Suspense fallback={<p>Loading...</p>}>
          <DemoMeeting />
        </Suspense>
      </main>
      <footer className={styles.footer}>© 2025 Voice Translate Demo</footer>
    </div>
  );
}
