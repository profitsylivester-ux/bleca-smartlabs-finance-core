import { redirect } from 'next/navigation';

/**
 * The root path has no content of its own.
 *
 * Sending it to /login rather than rendering a landing page is deliberate: a
 * marketing page in front of a finance system is a page that will eventually show
 * something it should not, and there is nothing here worth a separate route.
 */
export default function RootPage() {
  redirect('/login');
}
