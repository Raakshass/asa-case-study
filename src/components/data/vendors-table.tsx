import { CircleCheck, CircleX } from "lucide-react";
import { cn } from "cn";
import { TableFrame } from "@/components/shared/table-frame";
import { SOFT_TONE } from "@/components/shared/tones";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { MasterVendor } from "@/lib/types";
import { accountTail } from "./data-format";

/** Approved (green check) or Not approved (red cross): an icon and a word, never colour alone. */
function ApprovedBadge({ approved }: { approved: boolean }) {
  const Icon = approved ? CircleCheck : CircleX;
  return (
    <span
      data-approved={approved}
      className={cn(
        "inline-flex h-6 w-fit items-center gap-1.5 rounded-full border px-2.5 text-xs font-semibold whitespace-nowrap",
        approved ? SOFT_TONE.approve : SOFT_TONE.reject,
      )}
    >
      <Icon aria-hidden="true" className="size-3.5" />
      {approved ? "Approved" : "Not approved"}
    </span>
  );
}

/** A masked account number. The bullets are decoration: a screen reader hears "ending in 2233" instead. */
function MaskedAccount({ value }: { value: string | null }) {
  if (value === null) return <span className="text-muted-foreground">None on file</span>;
  const tail = accountTail(value);
  if (tail === null) return <span className="tabular-nums">{value}</span>;
  return (
    <span className="tabular-nums">
      <span aria-hidden="true">{value}</span>
      <span className="sr-only">Account ending in {tail}</span>
    </span>
  );
}

export interface VendorsTableProps {
  vendors: MasterVendor[];
}

/**
 * The vendors the rules know: name (with the aliases they also match), the approved badge, the masked bank account
 * and the phone number on file (the one used to verify a bank change); below 768 px the account and phone are
 * repeated under the name. Server-safe.
 */
export function VendorsTable({ vendors }: VendorsTableProps) {
  return (
    <TableFrame label="Vendors">
      <TableHeader>
        <TableRow className="bg-muted/50 hover:bg-muted/50">
          <TableHead scope="col" className="px-3">
            Vendor
          </TableHead>
          <TableHead scope="col" className="px-3">
            Status
          </TableHead>
          <TableHead scope="col" className="px-3">
            Bank account on file
          </TableHead>
          <TableHead scope="col" className="px-3">
            Phone on file
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {vendors.map((vendor) => (
          <TableRow key={vendor.id} data-vendor={vendor.id}>
            <TableCell className="px-3 py-3">
              <div className="flex flex-col gap-0.5">
                <span className="font-semibold text-foreground">{vendor.name}</span>
                <span className="text-xs text-muted-foreground tabular-nums">{vendor.id}</span>
                {vendor.aliases.length > 0 ? (
                  <span className="max-w-[22rem] text-xs whitespace-normal text-muted-foreground">
                    Also matched as: {vendor.aliases.join(", ")}
                  </span>
                ) : null}
                {/* Below 768 px the bank and phone columns are off the edge of the table's scroll frame: repeat them here (UI-1). */}
                <span data-vendor-inline="true" className="flex flex-col gap-0.5 text-xs whitespace-normal text-muted-foreground md:hidden">
                  <span>
                    Bank on file: <MaskedAccount value={vendor.bank_account_masked} />
                  </span>
                  <span>Phone on file: {vendor.phone_on_file ? <span className="tabular-nums">{vendor.phone_on_file}</span> : "none"}</span>
                </span>
              </div>
            </TableCell>
            <TableCell className="px-3 py-3">
              <ApprovedBadge approved={vendor.approved} />
            </TableCell>
            <TableCell className="px-3 py-3">
              <MaskedAccount value={vendor.bank_account_masked} />
            </TableCell>
            <TableCell className="px-3 py-3">
              {vendor.phone_on_file ? (
                <span className="tabular-nums">{vendor.phone_on_file}</span>
              ) : (
                <span className="text-muted-foreground">None on file</span>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </TableFrame>
  );
}
