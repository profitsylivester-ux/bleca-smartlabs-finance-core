import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'BLECA SmartLabs Finance',
    short_name: 'BLECA Finance',
    description: 'Finance management and accounting for BLECA SmartLabs. Double-entry core, controlled approvals, and a tamper-evident audit trail.',
    start_url: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#1e3a5f',
    orientation: 'portrait-primary',
    scope: '/',
    icons: [
      {
        src: '/icons/icon-72x72.png',
        sizes: '72x72',
        type: 'image/png',
        purpose: 'maskable',
      },
      {
        src: '/icons/icon-96x96.png',
        sizes: '96x96',
        type: 'image/png',
        purpose: 'maskable',
      },
      {
        src: '/icons/icon-128x128.png',
        sizes: '128x128',
        type: 'image/png',
        purpose: 'maskable',
      },
      {
        src: '/icons/icon-144x144.png',
        sizes: '144x144',
        type: 'image/png',
        purpose: 'maskable',
      },
      {
        src: '/icons/icon-152x152.png',
        sizes: '152x152',
        type: 'image/png',
        purpose: 'maskable',
      },
      {
        src: '/icons/icon-192x192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'maskable',
      },
      {
        src: '/icons/icon-384x384.png',
        sizes: '384x384',
        type: 'image/png',
        purpose: 'maskable',
      },
      {
        src: '/icons/icon-512x512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
    categories: ['finance', 'business', 'productivity'],
    shortcuts: [
      {
        name: 'New Transaction',
        short_name: 'Transaction',
        description: 'Create a new financial transaction',
        url: '/transactions/new',
        icons: [{ src: '/icons/transaction-icon.png', sizes: '192x192' }],
      },
      {
        name: 'Capture Receipt',
        short_name: 'Receipt',
        description: 'Capture a receipt (works offline)',
        url: '/offline/receipt',
        icons: [{ src: '/icons/receipt-icon.png', sizes: '192x192' }],
      },
    ],
    screenshots: [],
    related_applications: [],
    prefer_related_applications: false,
  };
}