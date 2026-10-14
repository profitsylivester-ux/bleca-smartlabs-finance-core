'use client';

import { useEffect, useState } from 'react';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function InstallButton() {
  const [prompt, setPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    function onPrompt(e: Event) {
      e.preventDefault();
      setPrompt(e as BeforeInstallPromptEvent);
    }
    function onInstalled() {
      setInstalled(true);
      setPrompt(null);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeinstallprompt', onPrompt);
      window.addEventListener('appinstalled', onInstalled);
      if (window.matchMedia('(display-mode: standalone)').matches) setInstalled(true);
    }
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  if (installed || !prompt) return null;

  async function install() {
    if (!prompt) return;
    try {
      await prompt.prompt();
      const result = await prompt.userChoice;
      if (result.outcome === 'accepted') setInstalled(true);
    } finally {
      setPrompt(null);
    }
  }

  return (
    <button
      type="button"
      onClick={install}
      className="text-muted-foreground hover:text-foreground rounded p-1.5"
      aria-label="Install as app"
      title="Install as app"
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 3v12M7 10l5 5 5-5" />
        <path d="M5 21h14" />
      </svg>
    </button>
  );
}
