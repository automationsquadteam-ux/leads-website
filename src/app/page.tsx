import { redirect } from 'next/navigation';

/** Both roles land on the dashboard; the shell adapts the nav to the role. */
export default function HomePage() {
  redirect('/dashboard');
}
