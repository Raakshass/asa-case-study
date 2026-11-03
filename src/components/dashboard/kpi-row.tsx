import { CircleDollarSign, Files, ShieldAlert } from "lucide-react";
import { DECISION_META } from "@/components/shared/decision-badge";
import { KpiTile } from "@/components/shared/kpi-tile";
import { Money } from "@/components/shared/money";
import type { DashboardKpis } from "@/lib/types";
import { shareOf } from "./run-format";

export interface KpiRowProps {
  /** The figures over ALL runs (the filter does not change them). null until the first response. */
  kpis: DashboardKpis | null;
  /** true until the first response settles: the tiles show skeletons instead of figures. */
  loading: boolean;
}

const NO_FIGURE = "–";

/**
 * The six KPI tiles of the dashboard: Total processed, Approved, On hold, Rejected, Security flags and the
 * dollar value approved. Two columns up to 1023px (below sm the security and money tiles take a whole row, so a
 * long figure never wraps and no cell is left empty), three columns from lg. Never six: a 30px figure such as
 * "$987,654.32" needs about 220px, which a sixth of the widest page (216px) and a third of a 640 to 860px page
 * do not offer (found by probing widths with a six-digit value). Without figures (the first request failed) every tile shows a dash. Server-safe (no state, no effects).
 */
export function KpiRow({ kpis, loading }: KpiRowProps) {
  const figure = (value: number | undefined) => (kpis ? (value ?? NO_FIGURE) : NO_FIGURE);
  const share = (count: number | undefined) => (kpis && count !== undefined ? shareOf(count, kpis.total) : null);
  const { APPROVE, HOLD, REJECT } = DECISION_META;
  return (
    <section aria-label="Key figures">
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3">
        <KpiTile label="Total processed" value={figure(kpis?.total)} icon={<Files />} loading={loading} hint="Every run, history included" />
        <KpiTile
          label="Approved"
          value={figure(kpis?.approved)}
          icon={<APPROVE.Icon />}
          tone={APPROVE.tone}
          loading={loading}
          hint={share(kpis?.approved)}
        />
        <KpiTile label="On hold" value={figure(kpis?.hold)} icon={<HOLD.Icon />} tone={HOLD.tone} loading={loading} hint={share(kpis?.hold)} />
        <KpiTile
          label="Rejected"
          value={figure(kpis?.rejected)}
          icon={<REJECT.Icon />}
          tone={REJECT.tone}
          loading={loading}
          hint={share(kpis?.rejected)}
        />
        <KpiTile
          label="Security flags"
          value={figure(kpis?.security_flags)}
          icon={<ShieldAlert />}
          tone="security"
          loading={loading}
          hint="Always held for review"
          className="col-span-2 sm:col-span-1"
        />
        <KpiTile
          label="Value approved"
          value={kpis ? <Money value={kpis.approved_value} /> : NO_FIGURE}
          icon={<CircleDollarSign />}
          tone={APPROVE.tone}
          loading={loading}
          hint="Invoice totals, tax included"
          className="col-span-2 sm:col-span-1"
        />
      </div>
    </section>
  );
}
