import { redirect } from 'next/navigation';

export default function LegacyEnrollPage({
  params,
  searchParams,
}: {
  params: { roomName: string };
  searchParams: { e2ee?: string };
}) {
  const q = new URLSearchParams();
  if (params.roomName) {
    q.set('room', params.roomName);
  }
  if (searchParams.e2ee) {
    q.set('e2ee', searchParams.e2ee);
  }
  const query = q.toString();
  redirect(query ? `/enroll?${query}` : '/enroll');
}
