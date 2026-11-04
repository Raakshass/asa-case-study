import {
  TEMPLATE_TOKEN,
  VARIABLES,
  isVarName,
  renderTemplate,
  shortLabel,
  type Vars,
} from "@/lib/workflow-graph";

/**
 * The fixed sample values the editor uses to preview a template (plan 8.8). Every other value shows its label in angle
 * brackets, for example "<Vendor phone on file>". Nothing here comes from an invoice.
 */
export const PREVIEW_VARS: Vars = {
  "run.vendor_name": "Globex Logistics Ltd",
  "run.invoice_number": "GLX-303",
  "run.total": 9900,
  "run.decision": "HOLD",
  "run.decision_text": "On hold",
  "run.first_reason": "Exceeds remaining PO balance by $3,000.00.",
  "run.url": "/runs/00000000-0000-4000-8000-000000000000",
  "summary.count": 2,
  "summary.total_value": 11550,
  "summary.list": "GLX-303, Globex Logistics Ltd, $9,900.00: Exceeds remaining PO balance by $3,000.00.\nIF-2210, Initech Facilities Co., $1,650.00: PO inferred as PO-1005, needs confirmation.",
  "po.remaining": 6000,
  "now.date": "2026-11-03",
};

/** The template with every {{name}} replaced by its sample value, or by its label in angle brackets. */
export function previewTemplate(template: string): string {
  return template.replace(TEMPLATE_TOKEN, (_all, name: string) => {
    if (!isVarName(name)) return "";
    if (Object.prototype.hasOwnProperty.call(PREVIEW_VARS, name)) return renderTemplate(`{{${name}}}`, PREVIEW_VARS, "none").text;
    return `<${shortLabel(VARIABLES[name].label)}>`;
  });
}
