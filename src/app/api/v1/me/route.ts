import { NextResponse } from 'next/server';
import { requireContext } from '@/lib/auth/guard';

export async function GET() {
  const ctx = await requireContext();
  const isCeo = (ctx.actor.roleCodes ?? []).includes('CEO');
  return NextResponse.json({ isCeo });
}
