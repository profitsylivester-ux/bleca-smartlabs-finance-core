import { Suspense } from 'react';
import SecurityEventsClient from './SecurityEventsClient';

export default function Page() {
  return (
    <Suspense fallback={<div className="p-8">Loading security events...</div>}>
      <SecurityEventsClient />
    </Suspense>
  );
}
