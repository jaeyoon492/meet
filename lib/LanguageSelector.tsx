import React, { useState, useEffect } from 'react';
import { useMaybeRoomContext } from '@livekit/components-react';

const LANGUAGE_OPTIONS = [
  { code: 'en', label: 'English' },
  { code: 'ko', label: 'Korean' },
  { code: 'ja', label: 'Japanese' },
  { code: 'zh', label: 'Chinese' },
  { code: 'es', label: 'Spanish' },
];

export function LanguageSelector() {
  const room = useMaybeRoomContext();
  const [selectedLang, setSelectedLang] = useState('jp');

  useEffect(() => {
    if (room?.localParticipant && selectedLang) {
      console.log('Setting language metadata:', selectedLang);
      room.localParticipant
        .setMetadata(JSON.stringify({ preferred_language: selectedLang }))
        .catch((e) => console.error('Metadata update failed:', e));
    }
  }, [selectedLang, room]);

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setSelectedLang(e.target.value);
  };

  return (
    <div style={{ position: 'absolute', top: 10, right: 10, zIndex: 999 }}>
      <label htmlFor="language-select" style={{ color: 'white', marginRight: 8 }}>
        Language:
      </label>
      <select id="language-select" value={selectedLang} onChange={handleChange}>
        {LANGUAGE_OPTIONS.map((lang) => (
          <option key={lang.code} value={lang.code}>
            {lang.label}
          </option>
        ))}
      </select>
    </div>
  );
}
