'use client';

import { Button } from '@/components/ui';

export default function CancelButton() {
  return (
    <Button variant='ghost' onClick={() => window.history.back()}>Cancel</Button>
  );
}
