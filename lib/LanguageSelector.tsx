import React, { useState, useEffect } from 'react';
import { useMaybeRoomContext, useParticipantInfo } from '@livekit/components-react';
import { LANGUAGE_OPTIONS } from './constants';

export function LanguageSelector(prop: { language: string }) {
  const room = useMaybeRoomContext();
  const [selectedLang, setSelectedLang] = useState(prop.language);

  function truncateFromFourth(str: string): string {
    if (str.length <= 3) return str;
    return str.slice(0, 3) + '...';
  }

  // useEffect(() => {
  //   if (room?.localParticipant && selectedLang) {
  //     console.log('Setting language metadata:', selectedLang);

  //     room.localParticipant
  //       .setMetadata(JSON.stringify({ preferred_language: selectedLang }))
  //       .catch((e) => console.error('Metadata update failed:', e));
  //   }
  // }, [selectedLang, room]);

  const handleChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    if (room?.localParticipant && selectedLang) {
      setSelectedLang(e.target.value);
      await room.localParticipant.setMetadata(
        JSON.stringify({
          preferred_language: e.target.value,
        }),
      );
    }
  };

  return (
    <div>
      <select
        id="language-select"
        value={selectedLang}
        onChange={handleChange}
        style={{
          width: '45px',
          padding: '0.5rem 0.2rem',
          borderRadius: '0.5rem',
          border: '1px solid #ffffff88',
          backgroundColor: '#000000',
          fontSize: '0.8rem',
          transition: 'border 0.2s ease',
        }}
      >
        {LANGUAGE_OPTIONS.map((lang) => (
          <option key={lang.code} value={lang.code}>
            {lang.label}
          </option>
        ))}
      </select>
    </div>
  );
}
