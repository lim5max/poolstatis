import type { ComponentProps } from 'react';
import { ChevronRight } from '@/components/icons';
import { cn } from '@/lib/utils';

export function DisclosureSummary({ className, children, chevron = true, ...props }: ComponentProps<'summary'> & { chevron?: boolean }) {
  return (
    <summary
      className={cn('list-none [&::-webkit-details-marker]:hidden', className)}
      {...props}
    >
      {chevron && <span
        data-slot="disclosure-chevron"
        aria-hidden="true"
        className="mr-1.5 inline-flex align-[-0.125em] transition-transform"
      >
        <ChevronRight className="size-3.5" />
      </span>}
      {children}
    </summary>
  );
}
