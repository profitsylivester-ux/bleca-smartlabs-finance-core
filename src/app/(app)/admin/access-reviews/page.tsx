import type { Metadata } from 'next';
import { requireContext } from '@/lib/auth/guard';
import { authorize } from '@/lib/kernel/authorize';
import { prisma } from '@/lib/db/prisma';
import { Badge, Card, CardBody, CardHeader, EmptyState, PageHeader } from '@/components/ui';
import { formatDate } from '@/lib/format';
import { DecideReviewItemForm } from '@/modules/users-roles/components/forms';

export const metadata: Metadata = { title: 'Access reviews' };

/**
 * Access reviews (PDF 4).
 *
 * A review snapshots the grants that existed when it was opened. That is the
 * point: a review that reads live rows would let a grant added mid-review appear
 * in the record as though it had always been there, which is exactly the gap a
 * review is supposed to close.
 */
export default async function AccessReviewsPage() {
  const ctx = await requireContext();
  await authorize(ctx, { module: 'USERS_ROLES', action: 'VIEW' });

  const reviews = await prisma.accessReview.findMany({
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      name: true,
      status: true,
      periodStart: true,
      periodEnd: true,
      createdAt: true,
      completedAt: true,
      items: {
        select: {
          id: true,
          decision: true,
          decisionReason: true,
          currentExpiresAt: true,
          user: { select: { fullName: true, emailNormalized: true } },
          role: { select: { code: true } },
        },
      },
    },
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Access reviews"
        description="Periodic certification that everyone still needs the access they hold."
      />

      {reviews.length === 0 ? (
        <Card>
          <EmptyState
            title="No access reviews yet"
            body="An access review is opened from the review controls once accounts exist. In Phase 1 this matters especially: two people holding every permission is not a sustainable control."
          />
        </Card>
      ) : (
        reviews.map((review) => {
          const decided = review.items.filter((i) => i.decision).length;
          return (
            <Card key={review.id}>
              <CardHeader
                title={review.name}
                description={`${formatDate(review.periodStart)} to ${formatDate(review.periodEnd)} - ${decided} of ${review.items.length} decided`}
                actions={
                  <Badge
                    tone={
                      review.status === 'COMPLETED'
                        ? 'success'
                        : decided === review.items.length && review.items.length > 0
                          ? 'success'
                          : 'warning'
                    }
                  >
                    {review.status}
                  </Badge>
                }
              />
              <CardBody className="px-0 py-0">
                {review.items.length === 0 ? (
                  <p className="text-muted-foreground px-5 py-6 text-sm">
                    No grants existed when this review was opened.
                  </p>
                ) : (
                  <ul className="divide-border-subtle divide-y">
                    {review.items.map((item) => (
                      <li key={item.id} className="px-5 py-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <span className="font-medium">{item.user.fullName}</span>
                            <span className="mono text-muted-foreground ml-2 text-xs">
                              {item.user.emailNormalized}
                            </span>
                            <Badge tone="neutral" className="ml-2">
                              {item.role.code}
                            </Badge>
                            {item.currentExpiresAt ? (
                              <span className="text-muted-foreground ml-2 text-xs">
                                expires {formatDate(item.currentExpiresAt)}
                              </span>
                            ) : null}
                          </div>
                          {item.decision ? (
                            <span className="text-muted-foreground text-xs">
                              <Badge tone={item.decision === 'REVOKE' ? 'danger' : 'success'}>
                                {item.decision}
                              </Badge>{' '}
                              {item.decisionReason}
                            </span>
                          ) : null}
                        </div>
                        {!item.decision ? (
                          <div className="mt-2">
                            <DecideReviewItemForm itemId={item.id} />
                          </div>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </CardBody>
            </Card>
          );
        })
      )}
    </div>
  );
}
