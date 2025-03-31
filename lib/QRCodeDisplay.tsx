// lib/QRCodeDisplay.tsx
'use client';

import React from 'react';
import { QRCodeCanvas } from 'qrcode.react';
import styles from '../styles/QRCodeDisplay.module.css';

export function QRCodeDisplay({ url, onClose }: { url: string; onClose: () => void }) {
  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100%',
        background: '#111',
        padding: '2rem',
        borderBottomLeftRadius: '1rem',
        borderBottomRightRadius: '1rem',
        boxShadow: '0 -4px 10px rgba(0,0,0,0.3)',
        zIndex: 1000,
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        animation: 'slideUp 0.3s ease-out',
      }}
    >
      <div
        style={{
          textAlign: 'center',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center',
        }}
      >
        <QRCodeCanvas value={url} size={180} />
        <p style={{ color: '#fff', marginTop: '1rem' }}>{url}</p>
        <button
          onClick={onClose}
          style={{
            marginTop: '1rem',
            padding: '0.5rem 1rem',
            background: '#333',
            color: 'white',
            border: 'none',
            borderRadius: '8px',
            cursor: 'pointer',
          }}
        >
          닫기
        </button>
      </div>

      <style>
        {`
          @keyframes slideUp {
            from {
              transform: translateY(-100%);
              opacity: 0;
            }
            to {
              transform: translateY(0);
              opacity: 1;
            }
          }
        `}
      </style>
    </div>
  );
}
