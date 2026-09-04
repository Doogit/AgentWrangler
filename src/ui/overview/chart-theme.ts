import { type ReactNode, createElement } from "react";

export const seriesPalette = [
  "var(--series-1)",
  "var(--series-2)",
  "var(--series-3)",
  "var(--series-4)",
  "var(--series-5)",
] as const;

export const gridProps = {
  axisLine: false,
  tickLine: false,
  grid: {
    stroke: "rgba(255, 255, 255, 0.07)",
    strokeDasharray: "5",
    horizontal: true,
    vertical: false,
  },
  tickCount: 5,
  preserveStartEnd: true,
} as const;

type TooltipEntry = {
  color?: string;
  dataKey?: string | number;
  name?: string | number;
  value?: string | number | null;
};

interface CustomTooltipProps {
  active?: boolean;
  label?: string | number;
  payload?: readonly TooltipEntry[];
  labelFormatter?: (label: string | number | undefined) => ReactNode;
  nameFormatter?: (name: TooltipEntry["name"], entry: TooltipEntry) => ReactNode;
  valueFormatter?: (value: TooltipEntry["value"], entry: TooltipEntry) => ReactNode;
}

/** Shared dark tooltip for Recharts series. */
export function CustomTooltip({
  active,
  label,
  payload,
  labelFormatter,
  nameFormatter,
  valueFormatter,
}: CustomTooltipProps) {
  if (!active || !payload?.length) return null;

  return createElement(
    "div",
    {
      style: {
        background: "#1e293b",
        border: "1px solid rgba(255, 255, 255, 0.12)",
        borderRadius: 8,
        boxShadow: "0 10px 24px rgba(0, 0, 0, 0.3)",
        color: "var(--text)",
        fontSize: 11,
        padding: "8px 10px",
      },
    },
    label !== undefined &&
      createElement(
        "div",
        { style: { color: "var(--text-2)", marginBottom: 5 } },
        labelFormatter?.(label) ?? label,
      ),
    ...payload.map((entry, index) =>
      createElement(
        "div",
        {
          key: `${entry.dataKey ?? entry.name ?? "series"}-${index}`,
          style: {
            color:
              entry.color?.startsWith("url(") === true
                ? seriesPalette[index % seriesPalette.length]
                : (entry.color ?? seriesPalette[index % seriesPalette.length]),
          },
        },
        `${nameFormatter?.(entry.name, entry) ?? entry.name ?? entry.dataKey ?? "Value"}: `,
        valueFormatter?.(entry.value, entry) ?? String(entry.value ?? "N/A"),
      ),
    ),
  );
}
