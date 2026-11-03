import Link from "next/link";
import { ArrowLeft, SearchX, Upload } from "lucide-react";
import { EmptyState } from "@/components/shared/empty-state";
import { CardSkeleton, ListSkeleton } from "@/components/shared/skeletons";
import { Button } from "@/components/ui/button";

/** Where to go from a page that has nothing to show: the dashboard and the start page. */
function Exits() {
  return (
    <>
      <Button asChild>
        <Link href="/">
          <ArrowLeft aria-hidden="true" />
          Back to the dashboard
        </Link>
      </Button>
      <Button asChild variant="outline">
        <Link href="/runs/new">
          <Upload aria-hidden="true" />
          Start a new run
        </Link>
      </Button>
    </>
  );
}

/** The link carries something that cannot be a run id (the API answered 400). The id is never echoed back. */
export function InvalidRun() {
  return (
    <EmptyState
      icon={<SearchX />}
      title="That is not a valid run link"
      description="A run link ends in the long id of a run. Check that the whole link was copied, or open the run from the dashboard."
      action={<Exits />}
    />
  );
}

/** A well-formed id that no run has (the API answered 404): never created, or removed by a demo reset. */
export function RunNotFound() {
  return (
    <EmptyState
      icon={<SearchX />}
      title="Run not found"
      description="There is no run with this id. It may never have existed, or the demo data was reset after it was created."
      action={<Exits />}
    />
  );
}

/** The shape of the whole page while the first response is on its way: decision card, stepper, PDF and fields. */
export function RunSkeleton() {
  return (
    <div className="space-y-6">
      <CardSkeleton lines={3} label="Loading the run" className="p-6" />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:items-start">
        <div className="min-w-0 rounded-xl bg-card p-4 ring-1 ring-foreground/10 sm:p-5">
          <ListSkeleton rows={10} />
        </div>
        <div className="min-w-0 space-y-6">
          <CardSkeleton lines={8} className="h-[26rem]" />
          <CardSkeleton lines={6} />
        </div>
      </div>
    </div>
  );
}
