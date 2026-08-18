import { useEffect, useState } from 'react';
import { Check } from '@/components/icons';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { resolveAnalyticsRange, type AnalyticsRangePreset, type AnalyticsRangeSelection } from '../analysis/ranges';

const QUICK_RANGES: Array<{ preset: AnalyticsRangePreset; label: string }> = [
  { preset: 'today', label: 'Today' },
  { preset: 'yesterday', label: 'Yesterday' },
  { preset: '7d', label: '7 days' },
  { preset: '30d', label: '30 days' },
  { preset: '90d', label: '90 days' },
];

export function AnalyticsDateRange({
  value,
  onChange,
  compare,
  onCompareChange,
  className,
}: {
  value: AnalyticsRangeSelection;
  onChange: (value: AnalyticsRangeSelection) => void;
  compare?: boolean;
  onCompareChange?: (value: boolean) => void;
  className?: string;
}) {
  const [customOpen, setCustomOpen] = useState(false);
  const [from, setFrom] = useState(value.kind === 'custom' ? value.from : '');
  const [to, setTo] = useState(value.kind === 'custom' ? value.to : '');
  const [error, setError] = useState<string | null>(null);
  const label = resolveAnalyticsRange(value).label;

  useEffect(() => {
    if (value.kind !== 'custom') return;
    setFrom(value.from);
    setTo(value.to);
  }, [value]);

  const openCustom = () => {
    if (value.kind === 'custom') {
      setFrom(value.from);
      setTo(value.to);
    }
    setError(null);
    setCustomOpen(true);
  };

  const applyCustom = () => {
    const next = { kind: 'custom', from, to } as const;
    try {
      resolveAnalyticsRange(next);
      onChange(next);
      setCustomOpen(false);
      setError(null);
    } catch (caught) {
      setError((caught as Error).message);
    }
  };

  return (
    <>
      <div role="group" aria-label="Analytics period" className={cn('flex min-w-0 items-center gap-2', className)}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" size="sm" variant="outline" className="h-9 max-w-full px-3" aria-label={`Period: ${label}`}>
              <span className="truncate">{label}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44">
            {QUICK_RANGES.map((item) => (
              <DropdownMenuCheckboxItem
                key={item.preset}
                checked={value.kind === 'preset' && value.preset === item.preset}
                onSelect={() => onChange({ kind: 'preset', preset: item.preset })}
              >
                {item.label}
              </DropdownMenuCheckboxItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={openCustom}>
              {value.kind === 'custom' ? 'Change custom period…' : 'Custom period…'}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {onCompareChange && (
          <Button
            type="button"
            size="sm"
            variant={compare ? 'secondary' : 'outline'}
            className="h-9 px-3"
            aria-label="Compare to previous period"
            aria-pressed={Boolean(compare)}
            onClick={() => onCompareChange(!compare)}
          >
            {compare && <Check className="size-4" />}
            Compare
          </Button>
        )}
      </div>

      <Dialog open={customOpen} onOpenChange={setCustomOpen}>
        <DialogContent aria-label="Custom period" className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="serif text-2xl font-normal">Custom period</DialogTitle>
            <DialogDescription>Choose inclusive calendar dates. Analytics uses UTC boundaries.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-2">
            <Label className="grid gap-2">
              Start date
              <Input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
            </Label>
            <Label className="grid gap-2">
              End date
              <Input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
            </Label>
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setCustomOpen(false)}>Cancel</Button>
            <Button type="button" onClick={applyCustom}>Apply period</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
