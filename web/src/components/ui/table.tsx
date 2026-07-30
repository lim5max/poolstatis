"use client"

import * as React from "react"

import { ArrowDown, ArrowUp, ChevronsUpDown } from "@/components/icons"
import { cn } from "@/lib/utils"

function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <div
      data-slot="table-container"
      className="relative w-full overflow-x-auto"
    >
      <table
        data-slot="table"
        className={cn("w-full caption-bottom text-sm", className)}
        {...props}
      />
    </div>
  )
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      data-slot="table-header"
      className={cn("bg-muted/35 [&_tr]:border-b", className)}
      {...props}
    />
  )
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  )
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn(
        "border-t bg-muted/50 font-medium [&>tr]:last:border-b-0",
        className
      )}
      {...props}
    />
  )
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "border-b transition-colors hover:bg-accent/40 has-aria-expanded:bg-accent/40 data-[state=selected]:bg-accent/55",
        className
      )}
      {...props}
    />
  )
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "h-10 px-2 text-left align-middle text-xs font-semibold whitespace-nowrap text-muted-foreground [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-0.5",
        className
      )}
      {...props}
    />
  )
}

type SortDirection = "asc" | "desc" | null

function SortableTableHead({
  className,
  direction,
  label,
  onSort,
  ...props
}: Omit<React.ComponentProps<"th">, "aria-sort" | "children"> & {
  direction: SortDirection
  label: string
  onSort: () => void
}) {
  const SortIcon = direction === "asc"
    ? ArrowUp
    : direction === "desc"
      ? ArrowDown
      : ChevronsUpDown

  return (
    <TableHead
      aria-sort={direction === "asc" ? "ascending" : direction === "desc" ? "descending" : "none"}
      className={cn("p-0", className)}
      {...props}
    >
      <button
        type="button"
        aria-label={`Sort by ${label}`}
        className="inline-flex h-10 w-full items-center justify-start gap-1.5 px-2 text-left font-medium text-foreground transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        onClick={onSort}
      >
        <span>{label}</span>
        <SortIcon
          aria-hidden="true"
          className={cn(
            "size-4 shrink-0 transition-colors",
            direction ? "text-foreground" : "text-muted-foreground/50",
          )}
          data-direction={direction ?? "none"}
          data-sort-icon
        />
      </button>
    </TableHead>
  )
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "p-2 align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-0.5",
        className
      )}
      {...props}
    />
  )
}

function TableCaption({
  className,
  ...props
}: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("mt-4 text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  SortableTableHead,
  TableRow,
  TableCell,
  TableCaption,
}
