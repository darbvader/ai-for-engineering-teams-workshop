import Link from 'next/link';
import { notFound } from 'next/navigation';

import { CustomerCard } from '@/components/CustomerCard';
import { mockCustomers } from '@/data/mock-customers';

interface CustomerProfilePageProps {
  /** Next 15 passes route params as a promise, so they must be awaited. */
  params: Promise<{ id: string }>;
}

/** Prerenders one route per mock customer, so every card link is a static page. */
export function generateStaticParams() {
  return mockCustomers.map((customer) => ({ id: customer.id }));
}

/**
 * Minimal destination for `CustomerCard`'s `href`, so the linked variant on the
 * showcase page navigates somewhere real instead of 404ing. A Server Component:
 * it reads mock data at request time and renders no interactive state.
 */
export default async function CustomerProfilePage({ params }: CustomerProfilePageProps) {
  const { id } = await params;
  const customer = mockCustomers.find((candidate) => candidate.id === id);

  if (!customer) {
    notFound();
  }

  return (
    <div className="min-h-screen bg-gray-50 p-4">
      <nav className="mb-8">
        <Link href="/" className="text-sm text-blue-700 underline hover:no-underline">
          ← Back to dashboard
        </Link>
      </nav>

      <h1 className="mb-2 text-4xl font-bold text-gray-900">{customer.name}</h1>
      <p className="mb-8 text-gray-600">{customer.company}</p>

      <section className="max-w-[400px]">
        {/* headingLevel={2} keeps the hierarchy correct under this page's <h1>. */}
        <CustomerCard customer={customer} headingLevel={2} />
      </section>
    </div>
  );
}
