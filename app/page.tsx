'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import React, { Suspense, useState } from 'react';
import { encodePassphrase, generateRoomId, randomString } from '@/lib/client-utils';
import Image from 'next/image';
import JusticeLogo from '@/components/ui/JusticeLogo';
import JusticeTextLogo from '@/components/ui/JusticeTextLogo';
import OfuFooterLogo from '@/components/ui/OfuFooterLogo';
import ArrowRightIcon from '@/components/ui/ArrowRightcon';

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
    <div className="flex items-center justify-center bg-ofu200 w-full h-full rounded-[8px]">
      <button className="lk-button" onClick={startMeeting}>
        <p className="text-[20px] font-medium text-white ">AI 접견 시작</p>
        <ArrowRightIcon />
      </button>
    </div>
  );
}

export default function Page() {
  return (
    <div className="min-h-screen bg-ofu100 text-white flex flex-col">
      <main className="flex-1 flex flex-col items-center justify-center" data-lk-theme="default">
        <header className="text-center mt-[104px] mb-[97px]">
          <p className="text-[22px] font-extrabold text-ofu300">AI Assistant</p>
          <p className="text-2xl font-bold text-black mt-2">지금 AI 접견을 진행해보세요.</p>
          <p className="text-lg font-normal text-ofu400 mt-2">
            아래 AI 접견 버튼을 누르면 접견이 시작됩니다.
          </p>
        </header>

        <JusticeLogo className="mb-[68px]" />
        <JusticeTextLogo />
      </main>
      <footer className="flex flex-col items-center justify-center h-[150px] text-center bg-white rounded-t-[20px] px-[27px] pt-[24px]">
        <DemoMeeting />
        <div>
          <OfuFooterLogo />
        </div>
      </footer>
    </div>
  );
}
