'use client';
import { Button } from '@/components/ui';

interface FormFooterProps {
  busy: boolean;
  onCancel: () => void;
  onSaveDraft: () => void;
  onSubmit: () => void;
  submitLabel?: string;
}

export function FormFooter({ busy, onCancel, onSaveDraft, onSubmit, submitLabel = 'Submit for Approval' }: FormFooterProps) {
  return (
    <div className="sticky bottom-0 z-10 -mx-6 mt-8 flex items-center justify-end gap-3 border-t border-border-subtle bg-white/90 px-6 py-4 backdrop-blur-sm">
      <Button variant="outline" type="button" onClick={onCancel} disabled={busy}>
        Cancel
      </Button>
      <Button variant="outline" type="button" onClick={onSaveDraft} disabled={busy}>
        {busy ? 'Saving...' : 'Save as Draft'}
      </Button>
      <Button type="button" onClick={onSubmit} disabled={busy} className="bg-navy-800 text-white">
        {busy ? 'Submitting...' : submitLabel}
      </Button>
    </div>
  );
}
