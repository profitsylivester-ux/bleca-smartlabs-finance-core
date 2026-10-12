import ReceiptPrintClient from './ReceiptPrintClient';
import { requireSalesPageActor } from '@/lib/sales/page-access';
export const metadata = { title: 'Receipt' };
export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  await requireSalesPageActor('RECEIPTS');
  const { id } = await params;
  return <ReceiptPrintClient id={id} />;
}
