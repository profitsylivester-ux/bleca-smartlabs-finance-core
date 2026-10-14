'use client';

import { useEffect, useState } from 'react';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function InstallButton() {
  const [prompt, setPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  useEffect(() => {
    function onPrompt(e: Event) {
      e.preventDefault();
      setPrompt(e as BeforeInstallPromptEvent);
    }
    function onInstalled() { setInstalled(true); setPrompt(null); }
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

  if (installed) return null;

  async function click() {
    if (prompt) {
      try {
        await prompt.prompt();
        const result = await prompt.userChoice;
        if (result.outcome === 'accepted') setInstalled(true);
      } finally {
        setPrompt(null);
      }
    } else {
      setShowHelp(true);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={click}
        className="inline-flex items-center gap-1.5 rounded-md border border-border-strong bg-white px-2.5 py-1 text-[12px] font-medium text-navy-800 hover:bg-navy-50"
        aria-label="Install as app"
        title="Install as app"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 3v12M7 10l5 5 5-5" />
          <path d="M5 21h14" />
        </svg>
        Install
      </button>
      {showHelp && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setShowHelp(false)}
        >
          <div
            className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="mb-2 text-base font-semibold">Install BLECA Finance</h2>
            <p className="text-muted-foreground mb-3 text-sm">
              Follow these steps in your browser to install this as an app:
            </p>
            <ul className="text-muted-foreground mb-4 space-y-2 pl-4 text-sm">
              <li><strong>Chrome / Edge on Windows, Mac, Linux:</strong> click the small install icon in the address bar on the right, or open the ⋮ menu and choose <strong>Install BLECA SmartLabs Finance</strong> / <strong>Install this app</strong>.</li>
              <li><strong>Android Chrome:</strong> open the ⋮ menu and tap <strong>Install app</strong> / <strong>Add to Home screen</strong>.</li>
              <li><strong>iOS Safari:</strong> tap Share at the bottom → <strong>Add to Home Screen</strong>.</li>
            </ul>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setShowHelp(false)}
                className="rounded border border-border px-3 py-1.5 text-sm"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
