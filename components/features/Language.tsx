'use client';

import * as React from 'react';
import { useMaybeRoomContext } from '@livekit/components-react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  Sheet,
  SheetTrigger,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from '@/components/ui/sheet';
import { Languages, Check } from 'lucide-react';
import { Drawer as VaulDrawer } from 'vaul';

import { LANGUAGE_OPTIONS } from '@/lib/constants'; // 예: [{ code: "ko", label: "한국어" }, ...]

function LanguageList({
  value,
  onChange,
  dense = false,
}: {
  value: string;
  onChange: (code: string) => void;
  dense?: boolean;
}) {
  return (
    <div className={dense ? 'px-2 py-1' : 'px-3 py-2'}>
      <div className="grid">
        {LANGUAGE_OPTIONS.map((lang) => {
          const isActive = lang.code === value;
          return (
            <button
              key={lang.code}
              onClick={() => onChange(lang.code)}
              className={`flex items-center justify-between rounded-xl px-3 py-3 text-left hover:bg-accent/60 ${
                isActive ? 'bg-accent/60' : ''
              }`}
            >
              <div className="min-w-0">
                <div className="font-medium leading-none truncate">{lang.label}</div>
                <div className="text-xs text-muted-foreground mt-1 truncate">{lang.code}</div>
              </div>
              {isActive && <Check className="h-4 w-4 shrink-0" aria-hidden />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// LiveKit 메타데이터 업데이트 헬퍼
async function setPreferredLanguage(room: ReturnType<typeof useMaybeRoomContext>, code: string) {
  const lkRoom = room; // alias
  if (!lkRoom?.localParticipant) return;

  // 기존 metadata를 보존하려면 파싱 후 병합
  let current: Record<string, any> = {};
  try {
    current = JSON.parse(lkRoom.localParticipant.metadata || '{}');
  } catch {}

  const next = { ...current, preferred_language: code };
  await lkRoom.localParticipant.setMetadata(JSON.stringify(next));
}

// 2) 모바일/바텀 드로어 (Vaul)
export function LanguageBottomDrawer({
  initialLanguage = 'en',
  buttonClassName,
  onChanged,
  open,
  handleOpen,
}: {
  initialLanguage?: string;
  buttonClassName?: string;
  onChanged?: (code: string) => void;
  open: boolean;
  handleOpen: () => void;
}) {
  const room = useMaybeRoomContext();
  const [lang, setLang] = React.useState(initialLanguage);

  const selectedLabel = React.useMemo(
    () => LANGUAGE_OPTIONS.find((x) => x.code === lang)?.label ?? lang,
    [lang],
  );

  const handleSelect = async (code: string) => {
    setLang(code);
    try {
      await setPreferredLanguage(room, code);
      onChanged?.(code);
      // 모바일은 선택 즉시 닫히는 UX가 자연스러우면 아래 주석 해제
      handleOpen();
    } catch (e) {
      console.error('Failed to set metadata:', e);
    }
  };

  return (
    <VaulDrawer.Root open={open} onOpenChange={handleOpen}>
      <VaulDrawer.Portal>
        <VaulDrawer.Overlay className="fixed inset-0 bg-black/70" />
        <VaulDrawer.Content className="fixed inset-x-0 bottom-0 z-50 mt-24 flex max-h-[80vh] flex-col rounded-t-3xl bg-background shadow-lg">
          <VaulDrawer.Handle className="mx-auto mt-3 h-1.5 w-12 rounded-full bg-muted" />

          <div className="px-4 py-4">
            <div className="text-base">Language</div>
          </div>
          <Separator />
          <LanguageList value={lang} onChange={handleSelect} dense />
        </VaulDrawer.Content>
      </VaulDrawer.Portal>
    </VaulDrawer.Root>
  );
}
